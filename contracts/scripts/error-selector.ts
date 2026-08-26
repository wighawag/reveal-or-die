import {keccak256, toBytes} from 'viem';

const args = process.argv.slice(2);

const errorSignature = args[0];
const selector = keccak256(toBytes(errorSignature)).slice(0, 10); // 0x + 8 hex characters (4 bytes)
console.log(selector); // This is the error selector in hex.
