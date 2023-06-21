import dotenv from "dotenv";
import { getDefaultProvider, Contract } from "ethers";
import { writeFile } from "fs/promises";

// ABI
import abi from "./abi.json" assert { type: "json" };

// Lib
import { stringify } from "./lib/json.js";

dotenv.config();

const provider = getDefaultProvider(process.env.PROVIDER_URL);
const contract = new Contract(process.env.TOKEN_ADDRESS, abi, provider);
const transfers = [];
const events = await contract.queryFilter(contract.filters.Transfer);

for (const event of events) {
  const [from, to, value] = event.args;

  transfers.push({
    block: event.blockNumber,
    from,
    to,
    value: BigInt(value),
  });
}

await writeFile("transfers.json", stringify(transfers));
