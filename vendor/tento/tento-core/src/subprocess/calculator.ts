#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run --unstable

// Import the RPC server implementation
import { RpcServer } from "./rpc-server.deno.ts";

/**
 * Add two numbers together.
 *
 * @param params - A dictionary containing 'n' and 'd' keys with numeric values
 * @returns A dictionary with the 'value' key containing the sum
 */
function add(params: any): Record<string, any> {
  try {
    if (typeof params.n != "number" && isNaN(Number(params.n))) {
      return { error: `Invalid number: ${params.n}` };
    }
    if (typeof params.d != "number" && isNaN(Number(params.d))) {
      return { error: `Invalid number: ${params.d}` };
    }

    const n = parseInt(String(params.n));
    const d = parseInt(String(params.d));

    if (isNaN(n) || isNaN(d)) {
      return { error: "Invalid number input" };
    }

    return { value: n + d };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Subtract one number from another.
 *
 * @param params - A dictionary containing 'n' and 'd' keys with numeric values
 * @returns A dictionary with the 'value' key containing the difference (n - d)
 */
function subtract(params: any): Record<string, any> {
  try {
    if (typeof params.n != "number" && isNaN(Number(params.n))) {
      return { error: `Invalid number: ${params.n}` };
    }
    if (typeof params.d != "number" && isNaN(Number(params.d))) {
      return { error: `Invalid number: ${params.d}` };
    }

    const n = parseInt(String(params.n));
    const d = parseInt(String(params.d));

    if (isNaN(n) || isNaN(d)) {
      return { error: "Invalid number input" };
    }

    return { value: n - d };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Multiply two numbers.
 *
 * @param params - A dictionary containing 'n' and 'd' keys with numeric values
 * @returns A dictionary with the 'value' key containing the product
 */
function multiply(params: any): Record<string, any> {
  try {
    if (typeof params.n != "number" && isNaN(Number(params.n))) {
      return { error: `Invalid number: ${params.n}` };
    }
    if (typeof params.d != "number" && isNaN(Number(params.d))) {
      return { error: `Invalid number: ${params.d}` };
    }

    const n = parseInt(String(params.n));
    const d = parseInt(String(params.d));

    if (isNaN(n) || isNaN(d)) {
      return { error: "Invalid number input" };
    }

    return { value: n * d };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Divide one number by another.
 *
 * @param params - A dictionary containing 'n' and 'd' keys with numeric values
 * @returns A dictionary with the 'value' key containing the quotient (n / d)
 */
function divide(params: any): Record<string, any> {
  try {
    if (typeof params.n != "number" && isNaN(Number(params.n))) {
      return { error: `Invalid number: ${params.n}` };
    }
    if (typeof params.d != "number" && isNaN(Number(params.d))) {
      return { error: `Invalid number: ${params.d}` };
    }

    const n = parseInt(String(params.n));
    const d = parseInt(String(params.d));

    if (isNaN(n) || isNaN(d)) {
      return { error: "Invalid number input" };
    }

    if (d === 0) {
      return { error: "Division by zero" };
    }

    return { value: n / d };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Initialize and run the calculator RPC server.
 */
console.error("[calculator] Starting calculator RPC server");
const server = new RpcServer();

// Register operation handlers
server.registerHandler("add", add);
server.registerHandler("subtract", subtract);
server.registerHandler("multiply", multiply);
server.registerHandler("divide", divide);

// Start the server
server.run();
