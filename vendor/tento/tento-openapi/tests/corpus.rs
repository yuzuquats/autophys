//! Native regression corpus against frozen utoipa 5.5 component maps.
//! For every root the maps must be equal, except for differences listed in
//! [`INTENDED`], which must each still occur (a fixed difference fails the
//! test until it is removed from the list).

#![allow(deprecated)]

use std::collections::BTreeMap;

use serde_json::Value;

mod corpus {
  pub mod app_command;
  pub mod brand;
  pub mod edge;
  pub mod lona_models;
}

use corpus::{app_command, brand, edge, lona_models};

type Map = BTreeMap<String, Value>;

fn frozen_components<T>() -> Map {
  let corpus: BTreeMap<String, Map> =
    serde_json::from_str(include_str!("fixtures/utoipa55-corpus.json")).unwrap();
  let name = std::any::type_name::<T>()
    .split_once("::corpus::")
    .unwrap()
    .1;
  corpus[name].clone()
}

fn tento_components<T: tento_openapi::ToSchema>() -> Map {
  tento_openapi::components_of::<T>()
    .schemas
    .into_iter()
    .map(|(name, schema)| (name, serde_json::to_value(schema).expect("tento json")))
    .collect()
}

/// Where two JSON values differ, as JSON pointers with both sides.
fn diff(path: &str, utoipa: Option<&Value>, tento: Option<&Value>, out: &mut Vec<String>) {
  match (utoipa, tento) {
    (Some(Value::Object(a)), Some(Value::Object(b))) => {
      let keys: std::collections::BTreeSet<&String> = a.keys().chain(b.keys()).collect();
      for key in keys {
        diff(&format!("{path}/{key}"), a.get(key), b.get(key), out);
      }
    }
    (Some(Value::Array(a)), Some(Value::Array(b))) if a.len() == b.len() => {
      for (i, (x, y)) in a.iter().zip(b).enumerate() {
        diff(&format!("{path}/{i}"), Some(x), Some(y), out);
      }
    }
    (a, b) if a == b => {}
    (a, b) => out.push(format!(
      "{path}: utoipa {} | tento {}",
      a.map_or("<absent>".into(), Value::to_string),
      b.map_or("<absent>".into(), Value::to_string)
    )),
  }
}

/// Differences kept on purpose: (root, line prefix, why).
const INTENDED: &[(&str, &str, &str)] = &[
  (
    "edge::UsesShadowedName",
    "UsesShadowedName/properties/value/",
    "utoipa matches the name `Value`; tento follows the type to its component",
  ),
  (
    "edge::UsesShadowedName",
    "Value: utoipa <absent>",
    "the component utoipa never registers because it never saw the type",
  ),
];

struct Report {
  roots: usize,
  components: usize,
  differences: Vec<String>,
}

fn compare<T: tento_openapi::ToSchema>(root: &str, report: &mut Report) {
  compare_maps(
    root,
    &frozen_components::<T>(),
    &tento_components::<T>(),
    report,
  );
}

fn compare_maps(root: &str, utoipa: &Map, tento: &Map, report: &mut Report) {
  report.roots += 1;
  report.components += utoipa.len().max(tento.len());
  let names: std::collections::BTreeSet<&String> = utoipa.keys().chain(tento.keys()).collect();
  for name in names {
    let mut out = Vec::new();
    diff("", utoipa.get(name), tento.get(name), &mut out);
    for line in out {
      report.differences.push(format!("{root} :: {name}{line}"));
    }
  }
  // `TENTO_OPENAPI_CORPUS_DUMP=<dir>` writes both maps, for reading by eye.
  if let Some(dir) = std::env::var_os("TENTO_OPENAPI_CORPUS_DUMP") {
    let dir = std::path::Path::new(&dir);
    std::fs::create_dir_all(dir).expect("dump dir");
    for (side, map) in [("utoipa", utoipa), ("tento", tento)] {
      let json = serde_json::to_string_pretty(map).expect("json");
      std::fs::write(dir.join(format!("{root}.{side}.json")), json).expect("dump");
    }
  }
  // Everything tento emits reads back into the model unchanged.
  for (name, json) in tento {
    let parsed: tento_openapi::RefOr<tento_openapi::Schema> =
      serde_json::from_value(json.clone()).unwrap_or_else(|e| panic!("{name} does not parse: {e}"));
    let again = serde_json::to_value(&parsed).expect("json");
    assert_eq!(&again, json, "{name} changes on a JSON round trip");
  }
}

/// The verdict: every difference must be intended, and every intended
/// difference must still occur.
fn verdict(report: &Report, intended: &[(&str, &str, &str)]) -> Result<usize, String> {
  let mut unexplained = Vec::new();
  let mut seen = vec![false; intended.len()];
  for line in &report.differences {
    match intended
      .iter()
      .position(|(root, prefix, _)| line.starts_with(&format!("{root} :: {prefix}")))
    {
      Some(i) => seen[i] = true,
      None => unexplained.push(line.clone()),
    }
  }
  let stale: Vec<_> = intended
    .iter()
    .zip(&seen)
    .filter(|(_, seen)| !**seen)
    .map(|((root, prefix, _), _)| format!("{root} :: {prefix}"))
    .collect();
  if unexplained.is_empty() && stale.is_empty() {
    return Ok(report.differences.len());
  }
  Err(format!(
    "unexplained differences:\n{}\nintended differences that no longer occur:\n{}",
    unexplained.join("\n"),
    stale.join("\n")
  ))
}

macro_rules! roots {
  ($report:ident: $($ty:path),* $(,)?) => {
    $(compare::<$ty>(stringify!($ty), &mut $report);)*
  };
}

/// The comparison is not vacuous: a changed description is reported.
#[test]
fn a_difference_is_reported() {
  let utoipa = frozen_components::<edge::Leaf>();
  let mut tento = tento_components::<edge::Leaf>();
  tento.get_mut("Leaf").unwrap()["description"] = Value::from("changed");
  let mut out = Vec::new();
  diff("", utoipa.get("Leaf"), tento.get("Leaf"), &mut out);
  assert_eq!(
    out,
    vec![r#"/description: utoipa "A referenced struct." | tento "changed""#.to_owned()]
  );
}

#[test]
fn derive_matches_utoipa_on_the_corpus() {
  let mut report = Report {
    roots: 0,
    components: 0,
    differences: Vec::new(),
  };
  roots!(report:
    app_command::AppCommand,
    brand::HeroMediaType,
    brand::FeatureMediaType,
    brand::FeatureSectionTheme,
    brand::SocialPlatform,
    brand::PricePeriod,
    brand::SchemaType,
    brand::Cta,
    brand::CtaSection,
    brand::HeroMedia,
    brand::HeroSection,
    brand::FeatureMedia,
    brand::FeatureHero,
    brand::Feature,
    brand::FeatureSection,
    brand::Stat,
    brand::Logo,
    brand::Testimonial,
    brand::CaseStudy,
    brand::Award,
    brand::SocialProofSection,
    brand::ComparisonRow,
    brand::ComparisonTable,
    brand::ComparisonSection,
    brand::FaqItem,
    brand::FaqSection,
    brand::NavLink,
    brand::NavDropdownItem,
    brand::NavDropdownColumn,
    brand::NavDropdownImage,
    brand::NavDropdown,
    brand::SiteNavItem,
    brand::SiteNav,
    brand::SocialLink,
    brand::FooterGroup,
    brand::FooterSection,
    brand::Integration,
    brand::IntegrationsSection,
    brand::PageMeta,
    brand::Price,
    brand::PricingTier,
    brand::PricingSection,
    brand::LandingPage,
    edge::Primitives,
    edge::Containers,
    edge::SerdeRules,
    edge::SchemaKeys,
    edge::UsesRenamed,
    edge::Strict,
    edge::Flattened,
    edge::OnlyMap,
    edge::UsesNewtypes,
    edge::Plain,
    edge::Kebab,
    edge::PlainTagged,
    edge::PlainUntagged,
    edge::Mixed,
    edge::Internal,
    edge::Untagged,
    edge::Adjacent,
    edge::Tree,
    edge::Old,
    edge::Defaults,
    edge::UsesShadowedName,
    edge::LeafCell,
    edge::ValueTypes,
    edge::Boxed,
    edge::Underscores,
    edge::SchemaRenamedVariants,
    lona_models::Rational,
    lona_models::TimeScale,
    lona_models::TimeScaleCustom,
    lona_models::TaskStatus,
    lona_models::TaskPriority,
    lona_models::TaskAttributes,
    lona_models::TaskInsert,
    lona_models::Task,
    lona_models::TaskUpdateAttributes,
    lona_models::TaskCell,
    lona_models::WeatherCell,
    lona_models::SlotCell,
    lona_models::TimezoneCell,
    lona_models::LogsCell,
    lona_models::NewUserSheet,
    lona_models::RowDef,
    lona_models::NewRowWithAttributes,
    lona_models::TemplateRowDef,
    lona_models::NewUserSheetWithRows,
    lona_models::NewSheet,
  );
  for line in &report.differences {
    eprintln!("  {line}");
  }
  eprintln!(
    "corpus: {} roots, {} components, {} differences",
    report.roots,
    report.components,
    report.differences.len(),
  );
  if let Err(failure) = verdict(&report, INTENDED) {
    panic!("{failure}");
  }
}

/// An injected difference goes through the same verdict as the corpus and
/// fails it; a listed difference that no longer occurs fails it too.
#[test]
fn the_verdict_rejects_unexplained_and_stale_differences() {
  let mut report = Report {
    roots: 0,
    components: 0,
    differences: Vec::new(),
  };
  compare::<edge::UsesShadowedName>("edge::UsesShadowedName", &mut report);
  assert_eq!(verdict(&report, INTENDED), Ok(2));

  let utoipa = frozen_components::<edge::Leaf>();
  let mut tento = tento_components::<edge::Leaf>();
  tento.get_mut("Leaf").unwrap()["description"] = Value::from("injected");
  compare_maps("edge::Leaf", &utoipa, &tento, &mut report);
  let failure = verdict(&report, INTENDED).unwrap_err();
  assert!(
    failure.contains(
      r#"edge::Leaf :: Leaf/description: utoipa "A referenced struct." | tento "injected""#
    ),
    "{failure}"
  );

  let fresh = Report {
    roots: 0,
    components: 0,
    differences: Vec::new(),
  };
  let failure = verdict(&fresh, INTENDED).unwrap_err();
  assert!(
    failure.contains("no longer occur:\nedge::UsesShadowedName"),
    "{failure}"
  );
}
