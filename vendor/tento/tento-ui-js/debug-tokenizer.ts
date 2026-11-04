import { LispTokenizer, SlowLispTokenizer } from "@tento-lisp/lisp-tokenizer";

// Test bracket notation
console.log("Testing bracket notation:");
const input1 = 'row["name"]';
console.log("Input:", input1);

const slow1 = new SlowLispTokenizer(input1).tokenize();
console.log("SlowLispTokenizer:", slow1);

const fast1 = new LispTokenizer(input1).tokenize();
console.log("LispTokenizer:", fast1);

// Test tagged strings
console.log("\nTesting tagged strings:");
const input2 = 'json`{"key": "value"}`';
console.log("Input:", input2);

const slow2 = new SlowLispTokenizer(input2).tokenize();
console.log("SlowLispTokenizer:", slow2);

const fast2 = new LispTokenizer(input2).tokenize();
console.log("LispTokenizer:", fast2);
