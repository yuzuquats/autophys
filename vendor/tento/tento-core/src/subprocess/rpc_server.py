import sys
import os
import json
import time
import threading
import signal
from json import JSONDecodeError
from typing import Dict, Callable, Any, Optional, TypeVar, Generic, Union

FOUR_KB = 4096 * 1024
MAX_FRAME_SIZE_BYTES = FOUR_KB

# Default interval between health checks (in seconds)
DEFAULT_HEALTH_CHECK_INTERVAL = 10
# Default timeout for health check (in seconds)
DEFAULT_HEALTH_CHECK_TIMEOUT = 5

T = TypeVar('T')
HandlerFn = Callable[[Any], Union[Dict[str, Any], str]]
HandlerTable = Dict[str, HandlerFn]

def eprint(*args, **kwargs):
  """Print to stderr."""
  print(*args, file=sys.stderr, **kwargs)


class MessageType:
  """Constants for message types."""
  PING = 0
  PONG = 1
  RPC_REQUEST = 2
  RPC_RESPONSE = 3


class Message:
  """Base class for all message types."""
  pass


class PingMessage(Message):
  """Ping message."""
  def __init__(self):
    self.type = MessageType.PING

  @classmethod
  def read(cls, _):
    """Read a ping message (which has no content)."""
    return cls()

  def write(self):
    """Write a ping message to stdout."""
    sys.stdout.buffer.write(MessageType.PING.to_bytes(length=1, byteorder='big', signed=False))
    sys.stdout.buffer.flush()


class PongMessage(Message):
  """Pong message."""
  def __init__(self):
    self.type = MessageType.PONG

  @classmethod
  def read(cls, _):
    """Read a pong message (which has no content)."""
    return cls()

  def write(self):
    """Write a pong message to stdout."""
    sys.stdout.buffer.write(MessageType.PONG.to_bytes(length=1, byteorder='big', signed=False))
    sys.stdout.buffer.flush()


class RpcRequestMessage(Message):
  """RPC request message."""
  def __init__(self, id: int, method: str, params: Dict[str, Any]):
    self.type = MessageType.RPC_REQUEST
    self.id = id
    self.method = method
    self.params = params

  @classmethod
  def read(cls, id: int):
    """Read an RPC request message from stdin."""
    # Read frame length
    req_frame_len_bytes = sys.stdin.buffer.read(4)
    if not req_frame_len_bytes:
        raise EOFError("Failed to read request frame length")

    req_frame_len = int.from_bytes(req_frame_len_bytes, byteorder='big', signed=False)
    if req_frame_len > MAX_FRAME_SIZE_BYTES:
        raise ValueError(f"Frame length {req_frame_len} exceeds maximum {MAX_FRAME_SIZE_BYTES}")

    # Read request body
    req_body_bytes = sys.stdin.buffer.read(req_frame_len)
    req_body_str = req_body_bytes.decode('utf-8')
    req_body = json.loads(req_body_str)

    # Extract method and params
    method = req_body.get("method", "")
    params = req_body.get("params", {})

    eprint(f"[server] Received RPC request: method={method}, params={params}")
    return cls(id, method, params)

  def write(self):
    """Write an RPC request to stdout."""
    message_type_bytes = self.type.to_bytes(length=1, byteorder='big', signed=False)
    id_bytes = self.id.to_bytes(length=8, byteorder='big', signed=False)

    body = {"method": self.method, "params": self.params}
    body_str = json.dumps(body)
    body_bytes = body_str.encode("utf-8")

    frame_len = len(body_bytes)
    frame_len_bytes = frame_len.to_bytes(length=4, byteorder='big', signed=False)

    sys.stdout.buffer.write(message_type_bytes)
    sys.stdout.buffer.write(id_bytes)
    sys.stdout.buffer.write(frame_len_bytes)
    sys.stdout.buffer.write(body_bytes)
    sys.stdout.buffer.flush()


class RpcResponseMessage(Message):
  """RPC response message."""
  def __init__(self, id: int, response: Dict[str, Any]):
    self.type = MessageType.RPC_RESPONSE
    self.id = id
    self.response = response

  @classmethod
  def read(cls, id: int):
    """Read an RPC response message from stdin."""
    # Read frame length
    resp_frame_len_bytes = sys.stdin.buffer.read(4)
    if not resp_frame_len_bytes:
        raise EOFError("Failed to read response frame length")

    resp_frame_len = int.from_bytes(resp_frame_len_bytes, byteorder='big', signed=False)
    if resp_frame_len > MAX_FRAME_SIZE_BYTES:
        raise ValueError(f"Frame length {resp_frame_len} exceeds maximum {MAX_FRAME_SIZE_BYTES}")

    # Read response body
    resp_body_bytes = sys.stdin.buffer.read(resp_frame_len)
    resp_body_str = resp_body_bytes.decode('utf-8')
    resp_body = json.loads(resp_body_str)

    eprint(f"[server] Received RPC response: {resp_body}")
    return cls(id, resp_body)

  def write(self):
    """Write an RPC response to stdout."""
    eprint(f"[server] Writing response: id={self.id}, response={self.response}")

    message_type_bytes = self.type.to_bytes(length=1, byteorder='big', signed=False)
    id_bytes = self.id.to_bytes(length=8, byteorder='big', signed=False)

    body_str = json.dumps(self.response)
    body_bytes = body_str.encode("utf-8")

    frame_len = len(body_bytes)
    frame_len_bytes = frame_len.to_bytes(length=4, byteorder='big', signed=False)

    sys.stdout.buffer.write(message_type_bytes)
    sys.stdout.buffer.write(id_bytes)
    sys.stdout.buffer.write(frame_len_bytes)
    sys.stdout.buffer.write(body_bytes)
    sys.stdout.buffer.flush()


def read_message() -> Optional[Message]:
  """
  Read a message from stdin.
  Returns the appropriate message object, or None if reading failed.
  """
  try:
    message_type_bytes = sys.stdin.buffer.read(1)
    if not message_type_bytes:
      eprint("[server] EOF reached")
      return None

    message_type = int.from_bytes(message_type_bytes, byteorder='big', signed=False)
    eprint(f"[server] message type: {message_type}")

    if message_type == MessageType.PING:
      return PingMessage.read(None)
    elif message_type == MessageType.PONG:
      return PongMessage.read(None)
    elif message_type == MessageType.RPC_REQUEST:
      # Read RPC ID
      req_rpc_id_bytes = sys.stdin.buffer.read(8)
      if not req_rpc_id_bytes:
        eprint("[server] Failed to read RPC ID")
        return None

      req_rpc_id = int.from_bytes(req_rpc_id_bytes, byteorder='big', signed=False)
      return RpcRequestMessage.read(req_rpc_id)
    elif message_type == MessageType.RPC_RESPONSE:
      # Read RPC ID
      resp_rpc_id_bytes = sys.stdin.buffer.read(8)
      if not resp_rpc_id_bytes:
        eprint("[server] Failed to read RPC ID")
        return None

      resp_rpc_id = int.from_bytes(resp_rpc_id_bytes, byteorder='big', signed=False)
      return RpcResponseMessage.read(resp_rpc_id)
    else:
      eprint(f"[server] Unknown message type: {message_type}")
      return None

  except EOFError:
    eprint("[server] EOF error")
    return None
  except KeyboardInterrupt:
    eprint("[server] Keyboard interrupt")
    return None
  except BrokenPipeError:
    eprint("[server] Broken pipe")
    return None
  except JSONDecodeError as e:
    eprint(f"[server] JSON decode error: {e}")
    return None
  except Exception as e:
    eprint(f"[server] Unexpected error: {e}")
    return None


class RpcServer:
  """
  A server that handles RPC requests from a parent process.
  """
  def __init__(self, handlers: HandlerTable = None, 
               health_check_interval: int = DEFAULT_HEALTH_CHECK_INTERVAL,
               health_check_timeout: int = DEFAULT_HEALTH_CHECK_TIMEOUT):
    """
    Initialize an RPC server with optional handlers.

    Args:
        handlers: A dictionary mapping method names to handler functions.
        health_check_interval: Interval in seconds between health checks.
        health_check_timeout: Timeout in seconds for considering process unhealthy.
    """
    self.handlers = handlers or {}
    self.health_check_interval = health_check_interval
    self.health_check_timeout = health_check_timeout
    self.last_ping_time = time.time()
    self.last_message_time = time.time()
    self.running = False
    self.health_check_thread = None

  def register_handler(self, method: str, handler: HandlerFn):
    """
    Register a handler function for a specific method.

    Args:
        method: The method name to handle.
        handler: The function to call when the method is invoked.
    """
    self.handlers[method] = handler

  def handle_message(self, message: Message) -> bool:
    """
    Handle a message received from the parent process.

    Args:
        message: The received message.

    Returns:
        True if the server should continue running, False otherwise.
    """
    # Update last message time regardless of message type
    self.last_message_time = time.time()
    
    if message is None:
      return False

    if isinstance(message, PingMessage):
      # Send a pong in response to a ping
      eprint("[server] Received ping, sending pong")
      pong = PongMessage()
      pong.write()
      # Record the ping time
      self.last_ping_time = time.time()
      
    elif isinstance(message, PongMessage):
      # Just record the pong
      eprint("[server] Received pong from parent")
      
    elif isinstance(message, RpcRequestMessage):
      # Handle an RPC request
      method = message.method
      handler = self.handlers.get(method)

      if handler:
        try:
          # Call the handler with the params
          result = handler(message.params)
          # Send a successful response
          response = RpcResponseMessage(message.id, result)
          response.write()
        except Exception as e:
          # Send an error response
          error_response = RpcResponseMessage(message.id, {"error": str(e)})
          error_response.write()
      else:
        # Method not found
        error_response = RpcResponseMessage(
          message.id,
          {"error": f"Method '{method}' not implemented"}
        )
        error_response.write()

    return True
    
  def health_check_loop(self):
    """
    Continuously check the health of the connection to the parent process.
    If no ping is received within the health check timeout, exit the process.
    """
    eprint("[server] Starting health check loop")
    while self.running:
      time.sleep(1)  # Check every second
      
      current_time = time.time()
      time_since_last_message = current_time - self.last_message_time
      time_since_last_ping = current_time - self.last_ping_time
      
      # If we haven't received any message in a while, exit
      if time_since_last_message > self.health_check_timeout:
        eprint(f"[server] No messages received in {time_since_last_message:.1f} seconds, exiting")
        # Exit with non-zero status to indicate error
        os._exit(1)
      
      # If we haven't received a ping in a specified interval, send one ourselves
      if time_since_last_ping > self.health_check_interval:
        eprint(f"[server] Sending ping to parent, last message {time_since_last_message:.1f}s ago")
        try:
          ping = PingMessage()
          ping.write()
        except Exception as e:
          eprint(f"[server] Failed to send ping to parent: {e}, exiting")
          os._exit(1)

  def run(self):
    """
    Start the RPC server and handle incoming messages.
    """
    eprint("[server] Starting RPC server")
    self.running = True
    
    # Start the health check thread
    self.health_check_thread = threading.Thread(target=self.health_check_loop, daemon=True)
    self.health_check_thread.start()
    
    # Handle SIGTERM gracefully
    def handle_sigterm(signum, frame):
      eprint("[server] Received SIGTERM, shutting down")
      self.running = False
      sys.exit(0)
    
    signal.signal(signal.SIGTERM, handle_sigterm)

    try:
      while self.running:
        message = read_message()
        if not self.handle_message(message):
          self.running = False
          break
    except KeyboardInterrupt:
      eprint("[server] Keyboard interrupt received, shutting down")
      self.running = False
    except Exception as e:
      eprint(f"[server] Fatal error in main loop: {e}, shutting down")
      self.running = False
      sys.exit(1)
    finally:
      eprint("[server] RPC server shutting down")


# Example calculator handler
def calculator_add(params):
  """
  Example handler function for adding two numbers.
  """
  try:
    n = int(params["n"])
    d = int(params["d"])
    return {"value": n + d}
  except Exception as e:
    return {"error": str(e)}


if __name__ == "__main__":
  # Example usage
  server = RpcServer()
  server.register_handler("add", calculator_add)
  server.run()