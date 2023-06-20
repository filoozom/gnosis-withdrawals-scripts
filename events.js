require('dotenv').config() // Load environment variables from .env file
const { ethers, assert } = require('ethers')
const Web3 = require('web3')
const fs = require('fs')

// Ethereum network provider
const providerUrl = process.env.PROVIDER_URL
const provider = new ethers.JsonRpcProvider(providerUrl)
const web3 = new Web3(providerUrl)

// ERC20 token contract address and ABI
const tokenAddress = process.env.TOKEN_ADDRESS
const sbcDepositAbi = [
  'function claimWithdrawal(address _address) public',
  'event Upgraded(address indexed implementation)',
]
const tokenAbi = [
  {
    constant: false,
    inputs: [
      {
        name: '_to',
        type: 'address',
      },
      {
        name: '_value',
        type: 'uint256',
      },
    ],
    name: 'transfer',
    outputs: [
      {
        name: '',
        type: 'bool',
      },
    ],
    payable: false,
    stateMutability: 'nonpayable',
    type: 'function',
  },
  // balanceOf
  {
    constant: true,
    inputs: [{ name: '_owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: 'balance', type: 'uint256' }],
    type: 'function',
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: '_from',
        type: 'address',
      },
      {
        indexed: true,
        name: '_to',
        type: 'address',
      },
      {
        indexed: false,
        name: '_value',
        type: 'uint256',
      },
    ],
    name: 'Transfer',
    type: 'event',
  },
]

// Sender and recipient private key and address
const sender = new ethers.Wallet(process.env.SENDER_PRIVATE_KEY, provider)
// comment if you do not require roundtrip transfer
const recipient = new ethers.Wallet(process.env.RECIPIENT_PRIVATE_KEY, provider)

// Create an instances of the contracts
const tokenContract = new ethers.Contract(tokenAddress, tokenAbi, provider)
const depositContract = new ethers.Contract(process.env.DEPOSIT_CONTRACT_ADDRESS, sbcDepositAbi, sender)

// Amount of tokens to transfer
const amount = ethers.parseUnits('1', 18) // 10 tokens with 18 decimals
// start balance from genesis.json for some addresses
const predefinedBalance = BigInt('0xc9f2c9cd04674edea40000000')

// Transfer ERC20 tokens
async function transferRoundTrip() {
  try {
    // Perform the token transfer
    const tx = await tokenContract.transfer(recipient.address, amount)
    console.log(`Transfer transaction hash: ${tx.hash}`)

    // Wait for the transaction to be confirmed
    await tx.wait()

    console.log(`Tokens transferred from: ${sender.address} to: ${recipient.address}`)

    // Perform the token transfer
    const txBack = await tokenContract.connect(recipient).transfer(sender.address, amount)
    console.log(`Back transfer transaction hash: ${tx.hash}`)

    // Wait for the transaction to be confirmed
    await txBack.wait()

    console.log(`Tokens transferred back from: ${recipient.address} to: ${sender.address}`)
  } catch (error) {
    console.error('Error transferring tokens:', error)
  }
}

async function claimAndCompareBalances() {
  const balance = await tokenContract.balanceOf(sender.address)
  console.log(`Balance before claim: ${balance}`)

  const claimTx = await depositContract.claimWithdrawal(sender.address)
  console.log(`Sended claim tx: ${claimTx.hash}`)
  await claimTx.wait()

  // get event from the last block
  const transferFilter = tokenContract.filters.Transfer
  const transferEvents = await tokenContract.queryFilter(transferFilter, -1)

  for (const event of transferEvents) {
    if (event.args[1] === sender.address) {
      const newBalance = await tokenContract.balanceOf(sender.address)
      const eventAmount = event.args[2]
      console.log(`Claimed amount from event: ${eventAmount}`)

      const balanceFromTransfer = balance + eventAmount
      console.log(`Asserting (balance before claim + claimed amount) == (balanceOf) after claim`)

      assert(
        balanceFromTransfer === newBalance,
        `Transfer event claimed value differs from actual, got (balance+value): ${balanceFromTransfer} expected: ${newBalance}`
      )
      console.log(balanceFromTransfer, ' == ', newBalance)
      console.log('SUCCESS')
      const blockNumber = event.blockNumber
      console.log(event)
      return { blockNumber, eventAmount }
    }
  }
}

async function compareWithdrawals(blockNumber, eventAmount) {
  try {
    const block = await web3.eth.getBlock(blockNumber)
    console.log(block)
    if (block.withdrawals.length > 0) {
      for (const withdrawal of block.withdrawals) {
        if (ethers.toBeHex(withdrawal.address) == ethers.toBeHex(withdrawal.address)) {
          const withdrawalAmount = BigInt(withdrawal.amount)
          assert(
            withdrawalAmount === eventAmount,
            `Withdrawal amount from block withdrawals list (${withdrawalAmount}) and event (${eventAmount}) differs`
          )
          console.log('SUCCESS')
          return
        }
      }
    } else {
      throw 'No withdrawals in a block'
    }
  } catch (error) {
    console.error('Error comparing withdrawals:', error)
  }
}

async function summWithdrawalsForAddress(startBlockNumber, endBlockNumber, address) {
  let withdrawals = BigInt(0)
  try {
    for (let i = startBlockNumber; i <= endBlockNumber; i++) {
      console.log('Processing block: ', i)
      const block = await web3.eth.getBlock(i)
      if (block.withdrawals) {
        for (const withdrawal of block.withdrawals) {
          if (address != withdrawal.address) {
            continue
          }
          withdrawals += BigInt(withdrawal.amount)
        }
      }
    }
    return withdrawals
  } catch (error) {
    console.error('Error counting withdrawals:', error)
    throw error
  }
}

const depositContractUpgradeBlock = 18093

async function getUpgradeEvents() {
  const upgradeFilter = depositContract.filters.Upgraded
  const upgradeEvents = await depositContract.queryFilter(upgradeFilter)
  for (const event of upgradeEvents) {
    console.log(event)
  }
}

async function getTransferEventsBlocks(address) {
  let values = []
  let blocks = [depositContractUpgradeBlock]
  try {
    const transferFilter = tokenContract.filters.Transfer
    const transferEvents = await tokenContract.queryFilter(transferFilter)
    for (const event of transferEvents) {
      const from = event.args[0]
      const to = event.args[1]
      const value = event.args[2]

      if (event.blockNumber < depositContractUpgradeBlock) {
        continue
      } else if (
        ethers.toBeHex(to) != address ||
        ethers.toBeHex(from) != ethers.toBeHex(process.env.DEPOSIT_CONTRACT_ADDRESS)
      ) {
        continue
      }

      blocks.push(event.blockNumber)
      values.push(value)
    }

    return { values, blocks }
  } catch (error) {
    console.error('Error retrieving ERC20 transfer events:', error)
    throw error
  }
}

async function syncWithdrawals(startBlock, endBlock, address) {
  let balance = BigInt(0)
  let end = 0
  for (start = startBlock; end < endBlock - 1; start += 1000) {
    end = start + 1000
    if (end >= endBlock) {
      end = endBlock - 1
    }
    balance += await summWithdrawalsForAddress(start, end, address)
  }
  return balance
}

async function compareWithdrawalsAndClaims(address) {
  let withdrawalsAccumulated = BigInt(0)
  let claimedAccumulated = BigInt(0)

  let data = await getTransferEventsBlocks(address)
  console.log(data)
  for (i = 0; i < data.blocks.length - 1; i++) {
    let intervalWithdrawalsMGNO = await syncWithdrawals(data.blocks[i], data.blocks[i + 1], address)
    let intervalWithdrawals = BigInt((intervalWithdrawalsMGNO * BigInt(1000000000)) / BigInt(32))
    console.log(`Withdrawals accumulated on blocks ${data.blocks[i]} --> ${data.blocks[i + 1]}: ${intervalWithdrawals}`)
    console.log(`Value claimed on block ${data.blocks[i + 1]}: ${data.values[i]}`)

    const newData = {
      fromBlock: data.blocks[i],
      toBlock: data.blocks[i + 1],
      claimed: data.values[i],
      withdrawalsAccumulated: intervalWithdrawals,
      match: intervalWithdrawals == BigInt(data.values[i]),
    }
    await appendDataToFile(newData)

    withdrawalsAccumulated += intervalWithdrawals
    claimedAccumulated += data.values[i]
  }
  console.log('Total tokens claimed: ', claimedAccumulated)
  console.log('Total withdrawals accumulated: ', withdrawalsAccumulated)
  assert(claimedAccumulated == withdrawalsAccumulated)
}

function appendDataToFile(newData) {
  // Read the existing data from the JSON file
  fs.readFile('data.json', 'utf8', (err, jsonString) => {
    if (err) {
      console.log('Error reading file:', err)
      return
    }

    let existingData
    try {
      existingData = JSON.parse(jsonString)
    } catch (err) {
      console.log('Error parsing JSON:', err)
      return
    }

    // Check if the existing data is an array
    if (!Array.isArray(existingData)) {
      existingData = []
    }

    // Append the new data to the existing data
    existingData.push(newData)

    // Convert BigInt values to strings for proper serialization
    const serializedData = JSON.stringify(
      existingData,
      (key, value) => {
        if (typeof value === 'bigint') {
          return value.toString()
        }
        return value
      },
      4
    )
    // Write the updated data back to the JSON file
    fs.writeFile('data.json', serializedData, 'utf8', (err) => {
      if (err) {
        console.log('Error writing file:', err)
      } else {
        console.log('Data appended to file successfully.')
      }
    })
  })
}

function sumAndCompareValues() {
  fs.readFile('data.json', 'utf8', (err, jsonString) => {
    if (err) {
      console.log('Error reading file:', err)
      return
    }

    let jsonData
    try {
      jsonData = JSON.parse(jsonString)
    } catch (err) {
      console.log('Error parsing JSON:', err)
      return
    }

    let claimedSum = 0n
    let withdrawalsAccumulatedSum = 0n

    for (const data of jsonData) {
      const claimed = BigInt(data.claimed)
      const withdrawalsAccumulated = BigInt(data.withdrawalsAccumulated)
      claimedSum += claimed
      withdrawalsAccumulatedSum += withdrawalsAccumulated
    }

    console.log('Sum of claimed values:', claimedSum.toString())
    console.log('Sum of withdrawalsAccumulated values:', withdrawalsAccumulatedSum.toString())

    if (claimedSum === withdrawalsAccumulatedSum) {
      console.log('The sums are equal.')
    } else {
      console.log('The sums are not equal.')
      const diff = withdrawalsAccumulatedSum - claimedSum
      console.log('Difference in values is: ', diff)
      console.log(('Withdrawal entries skipped: ', diff * BigInt(32)) / BigInt(1000000000) / BigInt(1525))
    }
  })
}

compareWithdrawalsAndClaims(ethers.toBeHex(sender.address))
