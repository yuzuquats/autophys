#!/usr/bin/env python3
from rpc_server import RpcServer

def add(params):
  """
  Add two numbers together.

  Args:
      params: A dictionary containing 'n' and 'd' keys with numeric values.

  Returns:
      A dictionary with the 'value' key containing the sum.
  """
  try:
    n = int(params["n"])
    d = int(params["d"])
    return {"value": n + d}
  except Exception as e:
    return {"error": str(e)}

def subtract(params):
  """
  Subtract one number from another.

  Args:
      params: A dictionary containing 'n' and 'd' keys with numeric values.

  Returns:
      A dictionary with the 'value' key containing the difference (n - d).
  """
  try:
    n = int(params["n"])
    d = int(params["d"])
    return {"value": n - d}
  except Exception as e:
    return {"error": str(e)}

def multiply(params):
  """
  Multiply two numbers.

  Args:
      params: A dictionary containing 'n' and 'd' keys with numeric values.

  Returns:
      A dictionary with the 'value' key containing the product.
  """
  try:
    n = int(params["n"])
    d = int(params["d"])
    return {"value": n * d}
  except Exception as e:
    return {"error": str(e)}

def divide(params):
  """
  Divide one number by another.

  Args:
      params: A dictionary containing 'n' and 'd' keys with numeric values.

  Returns:
      A dictionary with the 'value' key containing the quotient (n / d).
  """
  try:
    n = int(params["n"])
    d = int(params["d"])
    if d == 0:
      return {"error": "Division by zero"}
    return {"value": n / d}
  except Exception as e:
    return {"error": str(e)}

def main():
  """
  Initialize and run the calculator RPC server.
  """
  server = RpcServer()

  # Register handlers for different calculator operations
  server.register_handler("add", add)
  server.register_handler("subtract", subtract)
  server.register_handler("multiply", multiply)
  server.register_handler("divide", divide)

  # Start the server
  server.run()

if __name__ == "__main__":
  main()