use tento_agent_queue::QueueEnv;

#[tokio::main]
async fn main() {
  let env = match QueueEnv::load() {
    Ok(env) => env,
    Err(error) => {
      eprintln!("tento-agent-queue: {error}");
      std::process::exit(2);
    }
  };
  tento_agent_queue::cli::scripts(env).to_shell().run().await;
}
