const Web3 = require("web3");
const fs = require("fs");

const web3 = new Web3("https://rpc.chiadochain.net");

const contractABI = [
  {
    constant: false,
    inputs: [
      {
        name: "_to",
        type: "address",
      },
      {
        name: "_value",
        type: "uint256",
      },
    ],
    name: "transfer",
    outputs: [
      {
        name: "",
        type: "bool",
      },
    ],
    payable: false,
    stateMutability: "nonpayable",
    type: "function",
  },
  // balanceOf
  {
    constant: true,
    inputs: [{ name: "_owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "balance", type: "uint256" }],
    type: "function",
  },
  {
    anonymous: false,
    inputs: [
      {
        indexed: true,
        name: "_from",
        type: "address",
      },
      {
        indexed: true,
        name: "_to",
        type: "address",
      },
      {
        indexed: false,
        name: "_value",
        type: "uint256",
      },
    ],
    name: "Transfer",
    type: "event",
  },
];

// actually its ~ block when withdrawals started
let shapellaActivationBlock = 4100000;
// GNO token contract
const contractAddress = "0x19c653da7c37c66208fbfbe8908a5051b57b4c70";
const contract = new web3.eth.Contract(contractABI, contractAddress);
// change if necessary
const batchSize = 1000;
const threadCount = 3;

async function getLatestBlockNumber() {
  try {
    const blockNumber = await web3.eth.getBlockNumber();
    return blockNumber;
  } catch (error) {
    console.error("Error retrieving latest block number:", error);
    throw error;
  }
}

async function getHoldersFromTransferEvents() {
  let addressBalances = {};
  // try to load data from existing balances.json
  // otherwise will start sync from shapellaActivationBlock
  try {
    let raw;
    let obj;
    try {
      raw = fs.readFileSync("balances.json");
      obj = JSON.parse(raw);
      if (obj != null) {
        shapellaActivationBlock = obj.lastBlockSynced;
        addressBalances = obj.balances;
        return addressBalances;
      }
    } catch {}

    const latestBlockNumber = await web3.eth.getBlockNumber();
    const transferEvents = await contract.getPastEvents("Transfer", {
      fromBlock: 0,
      toBlock: latestBlockNumber,
    });

    for (const event of transferEvents) {
      const from = event.returnValues._from;
      const to = event.returnValues._to;

      if (!addressBalances[from]) {
        addressBalances[from] = await contract.methods.balanceOf(from).call();
        console.log("New holders list entry: ", from);
      }

      if (!addressBalances[to]) {
        addressBalances[to] = await contract.methods.balanceOf(to).call();
        console.log("New holders list entry: ", to);
      }
    }

    return addressBalances;
  } catch (error) {
    console.error("Error retrieving ERC20 transfer events:", error);
    throw error;
  }
}

async function addWithdrawalsAddresses(startBlockNumber, endBlockNumber, balances) {
  try {
    for (let i = startBlockNumber; i <= endBlockNumber; i++) {
      const block = await web3.eth.getBlock(i);
      if (block.withdrawals) {
        for (const withdrawal of block.withdrawals) {
          const address = withdrawal.address;
          if (!balances[address]) {
            balances[address] = await contract.methods.balanceOf(address).call();
            console.log("New holders list entry: ", address);
          }
        }
      }
    }
    return balances;
  } catch (error) {
    console.error("Error retrieving blocks:", error);
    throw error;
  }
}

function serializeBalances(balances) {
  const serialized = {};
  for (const key in balances) {
    serialized[key] = balances[key].toString();
  }
  return serialized;
}

async function processBlocks(startBlock, endBlock, addressBalances) {
  try {
    console.log("Processing blocks ", startBlock, "--> ", endBlock);
    addressBalances = await addWithdrawalsAddresses(startBlock, endBlock, addressBalances);
    return addressBalances;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  }
}

async function run() {
  try {
    const addressBalances = await getHoldersFromTransferEvents();
    console.log("Address Balances Before Withdrawals addition:", addressBalances);
    latestBlock = await getLatestBlockNumber();
    const blockRange = latestBlock - shapellaActivationBlock;
    const batchCount = Math.ceil(blockRange / batchSize);

    for (let batchIndex = 0; batchIndex < batchCount; batchIndex++) {
      let retryCount = 0;
      let success = false;
      let endBlock;

      while (!success && retryCount < 6) {
        // Retry up to 6 times (1 minute)
        try {
          const threadPromises = [];

          for (let threadIndex = 0; threadIndex < threadCount; threadIndex++) {
            const promise = new Promise(async (resolve, reject) => {
              try {
                let threadBalances = { ...addressBalances };

                const startBlock = shapellaActivationBlock + (batchIndex * threadCount + threadIndex) * batchSize;
                endBlock = startBlock + batchSize;
                endBlock = Math.min(endBlock, latestBlock);

                threadBalances = await processBlocks(startBlock, endBlock, threadBalances);

                resolve({ threadIndex, balances: threadBalances });
              } catch (error) {
                reject(error);
              }
            });

            threadPromises.push(promise);
          }

          const threadResults = await Promise.all(threadPromises);
          const mergedBalances = threadResults.reduce((result, { balances }) => {
            for (const address in balances) {
              if (!result[address]) {
                result[address] = balances[address];
              }
            }
            return result;
          }, {});

          // Prepare data to be written to the JSON file
          const currentDate = new Date();
          const executionTime = currentDate.toISOString();
          lastBlockSynced = endBlock;
          const data = {
            executionTime,
            lastBlockSynced,
            balances: serializeBalances(mergedBalances),
          };

          // Write data to the JSON file
          fs.writeFileSync(`balances.json`, JSON.stringify(data, null, 4));
          success = true;
        } catch (error) {
          console.error("Error during batch processing:", error);
          retryCount++;
          const waitTime = retryCount * 10000; // Wait for an increasing amount of time (10 seconds per retry)
          console.log(`Retrying in ${waitTime / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, waitTime));
        }
      }
      if (!success) {
        console.error("Batch processing failed after maximum retries. Exiting...");
        return;
      }
    }
  } catch (error) {
    console.error("Error:", error);
  }
}

run();
