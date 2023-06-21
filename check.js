import dotenv from "dotenv";
import { readFile } from "fs/promises";

// Lib
import { parse } from "./lib/json.js";

dotenv.config();

const { TOKEN_ADDRESS } = process.env;

const getWithdrawals = async () => {
  return parse(await readFile("withdrawals.json"), ["sum", "amount", "index"]);
};

const getTransfers = async () => {
  return parse(await readFile("transfers.json"), ["value"]);
};

const { withdrawals } = await getWithdrawals();
const allTransfers = await getTransfers();

//  Build transfers from the deposit contract per address
const transfers = {};
for (const transfer of allTransfers) {
  if (transfer.from !== TOKEN_ADDRESS) {
    continue;
  }

  if (!transfers[transfer.to]) {
    transfers[transfer.to] = [];
  }

  transfers[transfer.to].push(transfer);
}

// Check if the claims are correct for each address
for (const [address, events] of Object.entries(transfers)) {
  console.log(`Processing address ${address}`);

  let j = 0;
  const details = withdrawals[address.toLowerCase()].details.sort(
    (a, b) => a.block - b.block
  );

  for (let i = 0; i < events.length - 1; i++) {
    let sum = 0n;
    const range = {
      from: events[i].block,
      to: events[i + 1].block - 1,
    };

    for (; j < details.length; j++) {
      const detail = details[j];

      // Ignore all withdrawals before the first claim
      if (detail.block < range.from) {
        continue;
      }

      // Stop the loop if the withdrawal happened after the current claim
      if (detail.block > range.to) {
        break;
      }

      sum += (detail.amount * BigInt(1e9)) / 32n;
    }

    if (sum === events[i + 1].value) {
      console.log(`${range.from} - ${range.to}: success: ${sum}`);
    } else {
      console.log(
        `${range.from} - ${range.to}: wrong value: expected ${
          events[i + 1].value
        }, got ${sum}`
      );
    }
  }
}
