//! Measure the real sidebar's data preparation without a terminal.
//!
//! cargo run -p tento-lisp --release --example sidebar_pipeline -- SCENE FIXTURE_DIR [SAMPLES]
//!
//! Fixtures are the watcher's JSON files, retained privately. This runs the
//! scene's actual helpers. Only file.read and the initialization-only term.frame
//! constructor are supplied by this harness. It does not measure drawing,
//! compositor scheduling, producer queries, or terminal output.
use std::{cell::RefCell, path::PathBuf, rc::Rc, time::Instant};
use string_interner::{backend::StringBackend, symbol::SymbolU32};
use tento_lisp::{Env, Function, Interpreter, Runtime, RuntimeError, Value};

type V = Value<SymbolU32>;
type I = Interpreter<SymbolU32, StringBackend>;

struct Bench {
    interp: I,
    env: Rc<RefCell<Env<SymbolU32>>>,
}

impl Bench {
    fn parse(&mut self, source: &str) -> Vec<V> {
        Runtime::parse(None, source, self.interp.string_interner())
            .expect("parse benchmark")
            .into_iter()
            .map(|ast| V::from_owned_sexpression(ast).expect("value"))
            .collect()
    }

    fn eval(&mut self, forms: &[V]) -> V {
        let mut result = V::Nil;
        for form in forms {
            result = self.interp.eval_expression(self.env.clone(), form).expect("benchmark eval");
        }
        result
    }

    fn run(&mut self, source: &str) -> V {
        let forms = self.parse(source);
        self.eval(&forms)
    }

    fn measure(&mut self, name: &str, source: &str, samples: usize) {
        if let Ok(filter) = std::env::var("SIDEBAR_BENCH_PHASE") {
            if !name.contains(&filter) {
                return;
            }
        }
        let forms = self.parse(source);
        // Warm caches and exclude parsing and first use from repeated timings.
        for _ in 0..5 {
            std::hint::black_box(self.eval(&forms));
        }
        let mut times = Vec::with_capacity(samples);
        for _ in 0..samples {
            let start = Instant::now();
            let result = self.eval(&forms);
            times.push(start.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(result);
        }
        times.sort_by(f64::total_cmp);
        println!("{}", serde_json::json!({
            "phase": name, "samples": samples,
            "p50_ms": times[samples / 2],
            "p95_ms": times[(samples * 95 / 100).min(samples - 1)]
        }));
    }
}

fn main() {
    let args: Vec<_> = std::env::args().collect();
    assert!(args.len() >= 3, "SCENE FIXTURE_DIR [SAMPLES]");
    let scene = std::fs::read_to_string(&args[1]).expect("scene");
    let fixtures = PathBuf::from(&args[2]);
    let samples: usize = args.get(3).map(|s| s.parse().unwrap()).unwrap_or(100);
    assert!(samples > 0);
    let mut interp = I::new();
    let env = I::default_env(&mut interp);
    let file_read = interp.string_interner().get_or_intern("file.read");
    env.borrow_mut().define(file_read, V::Function(Function::NativeClosure(Rc::new(move |_, args| {
        let Some(V::String(path)) = args.first() else {
            return Err(RuntimeError::Other("file.read expects path".into()));
        };
        let text = match std::fs::read_to_string(fixtures.join(path.as_str())) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(RuntimeError::Other(e.to_string())),
        };
        Ok(V::String(text.into()))
    }))));
    let frame = interp.string_interner().get_or_intern("term.frame");
    env.borrow_mut().define(frame, V::Function(Function::NativeClosure(Rc::new(|_, args| {
        Ok(args.into_iter().next().unwrap_or(V::Nil))
    }))));
    let mut bench = Bench { interp, env };
    let init = scene.split_once(":state ").expect("scene :state").1
        .split_once("\n    :render ").expect("scene :render").0;
    bench.run(&format!("(let bench.state {init})"));
    bench.run("(tt.refresh)");
    for (view, all) in [("tree", false), ("tree", true), ("herdr", true)] {
        bench.run(&format!(
            "(set bench.state (assoc bench.state \"view\" \"{view}\" \"all\" {all}))
             (set tt.want-all {all}) (tt.refresh) (tt.screen bench.state)"
        ));
        let label = format!("{view}/{}", if all { "all" } else { "active" });
        let counts = bench.run("(list tt.thread-count tt.line-count)");
        println!("{}", serde_json::json!({"view": label, "counts": format!("{counts:?}")}));
        bench.measure(&format!("{label}/refresh-unchanged"), "(tt.refresh)", samples);
        bench.measure(&format!("{label}/catalog"), "(tt.build-threads)", samples);
        bench.measure(&format!("{label}/filing"),
            "(tt.file-threads bench.state (tt.shown-threads bench.state (tt.threads)))", samples);
        bench.measure(&format!("{label}/lines"), "(tt.lines bench.state tt.cached-threads)", samples);
        bench.measure(&format!("{label}/screen-rebuild"),
            "(set tt.gen (+ tt.gen 1)) (tt.screen bench.state)", samples);
        bench.measure(&format!("{label}/screen-cached"), "(tt.screen bench.state)", samples);
        // Keep a content digest without emitting private thread titles.
        let output = bench.run("(json-stringify (tt.lines bench.state tt.cached-threads))");
        let V::String(output) = output else { panic!("JSON result") };
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        output.hash(&mut hash);
        println!("{}", serde_json::json!({"view": label, "lines_digest": format!("{:016x}", hash.finish())}));
    }
    for count in [100, 1000, 4000] {
        for groups in [10, count] {
            bench.run(&format!(
                "(let bench.rows (map (lambda (i) (str (mod i {groups}))) (range {count})))"
            ));
            bench.measure(&format!("group-by/{count}/{groups}-keys"),
                "(group-by (lambda (x) x) bench.rows)", samples.min(30));
        }
    }
}
