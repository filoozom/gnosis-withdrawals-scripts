import Web3 from "web3";
import dotenv from "dotenv";
import { readFile, writeFile } from "fs/promises";

// Lib
import { parse, stringify } from "./lib/json.js";

dotenv.config();

const readCache = async () => {
  try {
    return parse(await readFile("withdrawals.json"), [
      "sum",
      "amount",
      "index",
    ]);
  } catch (err) {
    return {
      lastBlock: -1,
      withdrawals: {},
    };
  }
};

const web3 = new Web3(process.env.PROVIDER_URL);
const cache = await readCache();
const lastBlock = await web3.eth.getBlockNumber();

const handleBlock = async (number) => {
  const { withdrawals } = await web3.eth.getBlock(number);

  if (!withdrawals) {
    return;
  }

  for (const withdrawal of withdrawals) {
    if (!cache.withdrawals[withdrawal.address]) {
      cache.withdrawals[withdrawal.address] = {
        sum: 0n,
        details: [],
      };
    }

    cache.withdrawals[withdrawal.address].sum += BigInt(withdrawal.amount);
    cache.withdrawals[withdrawal.address].details.push({
      block: number,
      index: BigInt(withdrawal.index),
      amount: BigInt(withdrawal.amount),
    });
  }
};

for (let number = cache.lastBlock + 1; number < lastBlock; number += 100) {
  const to = number + 99;
  console.log(`Processing blocks ${number} to ${to}`);

  await Promise.all(
    Array.from(
      { length: Math.min(99, lastBlock - number) },
      (_, i) => number + i
    ).map(handleBlock)
  );

  cache.lastBlock = to;
  await writeFile("withdrawals.json", stringify(cache));
}
