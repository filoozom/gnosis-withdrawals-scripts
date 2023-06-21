export const stringify = (data) =>
  JSON.stringify(data, (_, value) =>
    typeof value === "bigint" ? value.toString() : value
  );

export const parse = (data, keys) =>
  JSON.parse(data, (key, value) =>
    keys.includes(key) ? BigInt(value) : value
  );
