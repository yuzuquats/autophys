//! The queue this host actually runs.
//!
//! Ignored by default: it enqueues real work, which starts a real tsh
//! session. Run it deliberately on a host where `tsh serve` and the
//! `tsh-agent-queue` daemon are up:
//!
//! ```sh
//! cargo test -p tento-agent-queue --test live -- --ignored --nocapture
//! ```
//!
//! It uses lane `normal` and a control form, the two things a default queue
//! declaration always has, so it needs no lane declared for it.

use std::time::Duration;

use tento_agent_queue::{AgentQueue, JobState, NewJob, QueueEnv};

#[tokio::test]
#[ignore = "enqueues real work on this host's queue"]
async fn a_control_job_runs_to_succeeded() {
  let env = QueueEnv::load().expect("queue env");
  let queue = AgentQueue::from_env(&env, "tento-agent-queue-smoke").expect("a queue");
  println!(
    "queue {} backend {}",
    queue.queue_name(),
    queue.backend_name()
  );

  let request = format!("smoke-{}", std::process::id());
  let enqueued = queue
    .enqueue(
      NewJob::ctl("normal", "(begin 1)")
        .title("tento-agent-queue smoke")
        .request(&request),
    )
    .await
    .expect("enqueue");
  println!("job {} {:?}", enqueued.job.id, enqueued.job.state);

  let settled = queue
    .wait(&enqueued.job.id, Duration::from_secs(180))
    .await
    .expect("the job settled");
  println!("settled {:?} result {:?}", settled.state, settled.result);
  assert_eq!(settled.state, JobState::Succeeded);
  // One attempt, and the session it ran in is named — the point of the queue.
  assert_eq!(settled.attempt_count, 1);
  assert!(
    settled
      .attempts
      .iter()
      .any(|attempt| attempt.session_id.is_some()),
    "an attempt records the session that carried it: {:?}",
    settled.attempts
  );

  // The same request again is the same job, not a second one.
  let again = queue
    .enqueue(NewJob::ctl("normal", "(begin 1)").request(&request))
    .await
    .expect("re-enqueue");
  assert!(again.duplicate);
  assert_eq!(again.job.id, enqueued.job.id);
}
