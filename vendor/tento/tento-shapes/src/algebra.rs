//! The render **shape algebra** (F13): a pane renders `container(element)`,
//! where shapes are composable *values* dispatched through the [`ShapeRegistry`].
//!
//! - `container ∈ {tree, stream, single}` — how a collection is laid out.
//! - `element ∈ {record (fields→columns), widget (a named concrete shape),
//!   union (dispatch by tag → a sub-shape)}` — how one datum renders.
//!
//! Homogeneity/heterogeneity is not a category — it's `element = record` vs
//! `element = union`. A union variant may itself be any shape (nesting):
//! `stream(union{kind→…})` is the trace stream; `tree(record)` is the fleet
//! tree. Shapes are plain serde values (`{"shape":"<tag>/v1", …}`), so they
//! ride the existing registry dispatch + recursion (`ShapeWidget::render`'s
//! `reg` param) rather than a parallel system.
//!
//! This module (Phase 1) is pure data + one transparent container widget. The
//! `tree`/`stream` container renderers and the Lisp constructors + `RenderConfig`
//! lowering land in later phases; here `single` proves a composed
//! `container(element)` value renders through the registry unchanged.

use std::collections::BTreeMap;
use std::fmt;

use serde_json::{Map, Value};

use crate::registry::{RenderCtx, ShapeOutput, ShapeRegistry, ShapeWidget};

/// Shape tag for a `container(element)` value.
pub const CONTAINER_V1: &str = "container/v1";
/// Shape tag for a `record` element (fields → columns).
pub const RECORD_V1: &str = "record/v1";
/// Shape tag for a `union` element (dispatch by tag → sub-shape).
pub const UNION_V1: &str = "union/v1";

/// How a collection is laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Container {
  Tree,
  Stream,
  Single,
}

impl Container {
  fn tag(self) -> &'static str {
    match self {
      Container::Tree => "tree",
      Container::Stream => "stream",
      Container::Single => "single",
    }
  }

  fn from_tag(s: &str) -> Result<Container, ShapeError> {
    match s {
      "tree" => Ok(Container::Tree),
      "stream" => Ok(Container::Stream),
      "single" => Ok(Container::Single),
      other => Err(ShapeError::Malformed(format!(
        "container/v1: unknown container '{other}'"
      ))),
    }
  }

  fn kind(self) -> ContainerKinds {
    match self {
      Container::Tree => ContainerKinds::TREE,
      Container::Stream => ContainerKinds::STREAM,
      Container::Single => ContainerKinds::SINGLE,
    }
  }
}

/// How one datum renders.
#[derive(Debug, Clone, PartialEq)]
pub enum Element {
  /// A flat record → columns. Lowered to a `RenderConfig` in a later phase.
  Record { columns: Vec<Value> },
  /// A named concrete shape (`table/v1`, `tree/v1`, …) plus its own fields —
  /// composition over the *existing* shape vocabulary.
  Widget {
    widget: String,
    extra: Map<String, Value>,
  },
  /// Dispatch a datum by its `by` field to a per-tag sub-shape (the union that
  /// `KindRouter` implements).
  Union {
    by: String,
    variants: BTreeMap<String, Shape>,
  },
}

impl Element {
  fn to_value(&self) -> Value {
    match self {
      Element::Record { columns } => {
        let mut m = Map::new();
        m.insert("shape".into(), Value::String(RECORD_V1.into()));
        m.insert("columns".into(), Value::Array(columns.clone()));
        Value::Object(m)
      }
      Element::Widget { widget, extra } => {
        let mut m = extra.clone();
        m.insert("shape".into(), Value::String(widget.clone()));
        Value::Object(m)
      }
      Element::Union { by, variants } => {
        let vs: Map<String, Value> = variants
          .iter()
          .map(|(k, v)| (k.clone(), v.to_value()))
          .collect();
        let mut m = Map::new();
        m.insert("shape".into(), Value::String(UNION_V1.into()));
        m.insert("by".into(), Value::String(by.clone()));
        m.insert("variants".into(), Value::Object(vs));
        Value::Object(m)
      }
    }
  }

  fn kind(&self) -> ElementKinds {
    match self {
      Element::Record { .. } => ElementKinds::RECORD,
      Element::Widget { .. } => ElementKinds::WIDGET,
      Element::Union { .. } => ElementKinds::UNION,
    }
  }

  fn describe(&self) -> String {
    match self {
      Element::Record { .. } => "record".into(),
      Element::Widget { widget, .. } => widget.clone(),
      Element::Union { .. } => "union".into(),
    }
  }
}

/// A composed render shape: a container wrapping an element (which may itself be
/// a container, via nesting), or a leaf element.
#[derive(Debug, Clone, PartialEq)]
pub enum Shape {
  Container {
    container: Container,
    element: Box<Shape>,
  },
  Leaf(Element),
}

impl Shape {
  // Constructors.
  pub fn record(columns: Vec<Value>) -> Shape {
    Shape::Leaf(Element::Record { columns })
  }
  pub fn widget(name: impl Into<String>) -> Shape {
    Shape::widget_with(name, Map::new())
  }
  pub fn widget_with(name: impl Into<String>, extra: Map<String, Value>) -> Shape {
    Shape::Leaf(Element::Widget {
      widget: name.into(),
      extra,
    })
  }
  pub fn union(by: impl Into<String>, variants: BTreeMap<String, Shape>) -> Shape {
    Shape::Leaf(Element::Union {
      by: by.into(),
      variants,
    })
  }
  pub fn tree(element: Shape) -> Shape {
    Shape::wrap(Container::Tree, element)
  }
  pub fn stream(element: Shape) -> Shape {
    Shape::wrap(Container::Stream, element)
  }
  pub fn single(element: Shape) -> Shape {
    Shape::wrap(Container::Single, element)
  }
  fn wrap(container: Container, element: Shape) -> Shape {
    Shape::Container {
      container,
      element: Box::new(element),
    }
  }

  /// Serialize to a shape-tagged JSON value the registry can dispatch.
  pub fn to_value(&self) -> Value {
    match self {
      Shape::Leaf(el) => el.to_value(),
      Shape::Container { container, element } => {
        let mut m = Map::new();
        m.insert("shape".into(), Value::String(CONTAINER_V1.into()));
        m.insert("container".into(), Value::String(container.tag().into()));
        m.insert("element".into(), element.to_value());
        Value::Object(m)
      }
    }
  }

  /// Parse a shape-tagged JSON value. Any tag that isn't `container/v1`,
  /// `record/v1`, or `union/v1` is a `Widget` element over that concrete shape.
  pub fn try_from_value(value: &Value) -> Result<Shape, ShapeError> {
    let tag = value
      .get("shape")
      .and_then(Value::as_str)
      .ok_or(ShapeError::NotAShape)?;
    match tag {
      CONTAINER_V1 => {
        let container = Container::from_tag(
          value
            .get("container")
            .and_then(Value::as_str)
            .ok_or_else(|| ShapeError::Malformed("container/v1: missing 'container'".into()))?,
        )?;
        let element = value
          .get("element")
          .ok_or_else(|| ShapeError::Malformed("container/v1: missing 'element'".into()))?;
        Ok(Shape::wrap(container, Shape::try_from_value(element)?))
      }
      RECORD_V1 => Ok(Shape::record(
        value
          .get("columns")
          .and_then(Value::as_array)
          .cloned()
          .unwrap_or_default(),
      )),
      UNION_V1 => {
        let by = value
          .get("by")
          .and_then(Value::as_str)
          .unwrap_or("kind")
          .to_string();
        let obj = value
          .get("variants")
          .and_then(Value::as_object)
          .ok_or_else(|| ShapeError::Malformed("union/v1: missing 'variants'".into()))?;
        let mut variants = BTreeMap::new();
        for (k, sv) in obj {
          variants.insert(k.clone(), Shape::try_from_value(sv)?);
        }
        Ok(Shape::union(by, variants))
      }
      other => {
        let mut extra = value.as_object().cloned().unwrap_or_default();
        extra.remove("shape");
        Ok(Shape::widget_with(other, extra))
      }
    }
  }

  /// Check this shape against a pane's accepted-shape signature. `Ok(())` if
  /// the pane can render it; `Err(Rejected{expected, got})` otherwise — the
  /// scene builder turns that into a build error.
  pub fn check(&self, sig: &ShapeSig) -> Result<(), ShapeError> {
    match (self, sig) {
      (_, ShapeSig::Any) => Ok(()),
      (Shape::Leaf(el), ShapeSig::Element(kinds)) if kinds.contains(el.kind()) => Ok(()),
      (Shape::Container { container, element }, ShapeSig::Container(ckinds, inner))
        if ckinds.contains(container.kind()) =>
      {
        element.check(inner)
      }
      _ => Err(ShapeError::Rejected {
        expected: sig.describe(),
        got: self.describe(),
      }),
    }
  }

  /// A human name for error messages: `tree(record)`, `stream(union)`, …
  pub fn describe(&self) -> String {
    match self {
      Shape::Leaf(el) => el.describe(),
      Shape::Container { container, element } => {
        format!("{}({})", container.tag(), element.describe())
      }
    }
  }
}

// ===========================================================================
// Accepted-shape signatures (what a pane declares it renders)
// ===========================================================================

/// A bitset over element kinds a pane accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ElementKinds(u8);

impl ElementKinds {
  pub const RECORD: ElementKinds = ElementKinds(1);
  pub const WIDGET: ElementKinds = ElementKinds(2);
  pub const UNION: ElementKinds = ElementKinds(4);

  pub const fn or(self, other: ElementKinds) -> ElementKinds {
    ElementKinds(self.0 | other.0)
  }
  fn contains(self, other: ElementKinds) -> bool {
    self.0 & other.0 != 0
  }
  fn describe(self) -> String {
    let mut parts = Vec::new();
    if self.contains(ElementKinds::RECORD) {
      parts.push("record");
    }
    if self.contains(ElementKinds::WIDGET) {
      parts.push("widget");
    }
    if self.contains(ElementKinds::UNION) {
      parts.push("union");
    }
    parts.join("|")
  }
}

/// A bitset over container kinds a pane accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ContainerKinds(u8);

impl ContainerKinds {
  pub const TREE: ContainerKinds = ContainerKinds(1);
  pub const STREAM: ContainerKinds = ContainerKinds(2);
  pub const SINGLE: ContainerKinds = ContainerKinds(4);

  pub const fn or(self, other: ContainerKinds) -> ContainerKinds {
    ContainerKinds(self.0 | other.0)
  }
  fn contains(self, other: ContainerKinds) -> bool {
    self.0 & other.0 != 0
  }
  fn describe(self) -> String {
    let mut parts = Vec::new();
    if self.contains(ContainerKinds::TREE) {
      parts.push("tree");
    }
    if self.contains(ContainerKinds::STREAM) {
      parts.push("stream");
    }
    if self.contains(ContainerKinds::SINGLE) {
      parts.push("single");
    }
    parts.join("|")
  }
}

/// The shape a pane declares it can render — matched structurally by
/// [`Shape::check`].
pub enum ShapeSig {
  Any,
  Element(ElementKinds),
  Container(ContainerKinds, Box<ShapeSig>),
}

impl ShapeSig {
  fn describe(&self) -> String {
    match self {
      ShapeSig::Any => "any".into(),
      ShapeSig::Element(kinds) => kinds.describe(),
      ShapeSig::Container(ckinds, inner) => format!("{}({})", ckinds.describe(), inner.describe()),
    }
  }
}

/// Why a shape value couldn't be built or accepted.
#[derive(Debug, Clone, PartialEq)]
pub enum ShapeError {
  /// The value carries no `shape` tag.
  NotAShape,
  /// The value has a shape tag but bad structure.
  Malformed(String),
  /// A composed shape a pane's signature rejects.
  Rejected { expected: String, got: String },
}

impl fmt::Display for ShapeError {
  fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match self {
      ShapeError::NotAShape => write!(f, "not a shape value (no `shape` tag)"),
      ShapeError::Malformed(m) => write!(f, "{m}"),
      ShapeError::Rejected { expected, got } => {
        write!(f, "shape {got} not accepted (expects {expected})")
      }
    }
  }
}

impl std::error::Error for ShapeError {}

// ===========================================================================
// The `single` container widget — the transparent Phase-1 proof
// ===========================================================================

/// Renders `container/v1` values. `single(element)` is a transparent
/// passthrough — it renders the inner element through the registry with the
/// same context, so the output is byte-identical to rendering the element
/// directly. The `tree`/`stream` containers are rendered by host-side widgets
/// (later phases); here they degrade to a single diagnostic line.
pub struct SingleWidget;

impl ShapeWidget for SingleWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[CONTAINER_V1]
  }

  fn render(&self, value: &Value, width: u16, ctx: &RenderCtx, reg: &ShapeRegistry) -> ShapeOutput {
    match Shape::try_from_value(value) {
      Ok(Shape::Container {
        container: Container::Single,
        element,
      }) => {
        let inner = element.to_value();
        reg
          .render(&inner, width, ctx)
          .unwrap_or_else(|| crate::render_fallback(&inner, width))
      }
      Ok(Shape::Container { container, .. }) => ShapeOutput::diagnostic(format!(
        "  (container/v1: {} rendered by host — Phase 3+)",
        container.tag()
      )),
      Ok(Shape::Leaf(_)) => ShapeOutput::diagnostic("  (container/v1: value is not a container)"),
      Err(e) => ShapeOutput::diagnostic(format!("  (container/v1: {e})")),
    }
  }
}

/// Renders `union/v1` values — the heterogeneous element that dispatches a datum
/// by a tag field (`by`, default `"kind"`) to a per-tag variant shape. This is
/// the value form of what `KindRouter` does per row. A union is a *dispatch
/// table*, so it renders only when applied to a datum, carried in the optional
/// `value` field (the `stream` container feeds each row here in a later phase);
/// a bare spec degrades to a diagnostic. The chosen variant renders the datum
/// (its fields merged onto the variant shape), recursing through `reg`.
pub struct UnionWidget;

impl ShapeWidget for UnionWidget {
  fn shapes(&self) -> &'static [&'static str] {
    &[UNION_V1]
  }

  fn render(&self, value: &Value, width: u16, ctx: &RenderCtx, reg: &ShapeRegistry) -> ShapeOutput {
    let Some(datum) = value.get("value") else {
      return ShapeOutput::diagnostic("  (union/v1: no value to dispatch)");
    };
    let by = value.get("by").and_then(Value::as_str).unwrap_or("kind");
    let tag = datum.get(by).and_then(Value::as_str).unwrap_or_default();
    let Some(variant) = value.get("variants").and_then(|v| v.get(tag)) else {
      return ShapeOutput::diagnostic(format!("  (union/v1: no variant for {by}={tag})"));
    };
    let merged = merge_datum(variant, datum);
    reg
      .render(&merged, width, ctx)
      .unwrap_or_else(|| crate::render_fallback(&merged, width))
  }
}

/// Merge a datum's data fields onto a variant shape value so the variant's
/// renderer sees the data. The variant's `shape` tag is authoritative; every
/// other datum field is copied in.
fn merge_datum(variant: &Value, datum: &Value) -> Value {
  let mut m = variant.as_object().cloned().unwrap_or_default();
  if let Some(d) = datum.as_object() {
    for (k, v) in d {
      if k != "shape" {
        m.insert(k.clone(), v.clone());
      }
    }
  }
  Value::Object(m)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::registry::RenderCtx;
  use serde_json::json;

  fn table_value() -> Value {
    json!({
      "shape": "table/v1",
      "columns": [{"header": "Name"}, {"header": "Qty"}],
      "rows": [["apple", "3"], ["pear", "7"]],
    })
  }

  #[test]
  fn grammar_round_trips_through_json() {
    let mut variants = BTreeMap::new();
    variants.insert(
      "exec".to_string(),
      Shape::tree(Shape::record(vec![json!({"path": "attrs.cmd"})])),
    );
    variants.insert(
      "http".to_string(),
      Shape::record(vec![json!({"path": "attrs.method"})]),
    );
    let shape = Shape::stream(Shape::union("kind", variants));
    let round = Shape::try_from_value(&shape.to_value()).expect("parses");
    assert_eq!(shape, round);

    // A widget element round-trips through its concrete tag.
    let w = Shape::single(Shape::try_from_value(&table_value()).unwrap());
    assert_eq!(w, Shape::try_from_value(&w.to_value()).unwrap());
  }

  #[test]
  fn single_widget_is_transparent() {
    let reg = ShapeRegistry::core(); // includes SingleWidget (registered in core())
    let ctx = RenderCtx::cli();
    let inner = table_value();
    let bare = reg.render(&inner, 60, &ctx).expect("table renders");

    let wrapped_shape = Shape::single(Shape::try_from_value(&inner).unwrap());
    let wrapped = reg
      .render(&wrapped_shape.to_value(), 60, &ctx)
      .expect("single renders");

    assert_eq!(
      bare.lines, wrapped.lines,
      "single(table) must match bare table"
    );
    assert_eq!(bare.paths, wrapped.paths);
    assert_eq!(bare.attrs, wrapped.attrs);
  }

  #[test]
  fn sig_accepts_and_rejects() {
    // A TreePane-style signature: tree|single container over any element.
    let sig = ShapeSig::Container(
      ContainerKinds::TREE.or(ContainerKinds::SINGLE),
      Box::new(ShapeSig::Element(
        ElementKinds::RECORD
          .or(ElementKinds::WIDGET)
          .or(ElementKinds::UNION),
      )),
    );
    assert!(Shape::single(Shape::record(vec![])).check(&sig).is_ok());
    assert!(Shape::tree(Shape::record(vec![])).check(&sig).is_ok());

    let err = Shape::stream(Shape::record(vec![]))
      .check(&sig)
      .expect_err("stream is rejected");
    match err {
      ShapeError::Rejected { expected, got } => {
        assert!(got.contains("stream"), "got: {got}");
        assert!(expected.contains("tree"), "expected: {expected}");
      }
      other => panic!("wrong error: {other:?}"),
    }
  }

  #[test]
  fn unknown_and_malformed_containers_degrade() {
    let reg = ShapeRegistry::core();
    let ctx = RenderCtx::cli();
    // A bogus container string.
    let bad = json!({"shape": "container/v1", "container": "nope", "element": table_value()});
    let out = reg.render(&bad, 60, &ctx).expect("dispatches");
    assert_eq!(out.lines.len(), 1);
    // tree/stream are host-rendered later — a single placeholder line, no panic.
    let tree = Shape::tree(Shape::record(vec![])).to_value();
    let out = reg.render(&tree, 60, &ctx).expect("dispatches");
    assert_eq!(out.lines.len(), 1);
    assert!(out.lines[0].contains("Phase 3+"), "{}", out.lines[0]);
  }

  #[test]
  fn union_dispatches_a_datum_to_its_variant() {
    let reg = ShapeRegistry::core(); // includes UnionWidget
    let ctx = RenderCtx::cli();
    // A union over `kind` with a table/v1 variant; the datum carries kind + data.
    let u = json!({
      "shape": "union/v1", "by": "kind",
      "variants": { "tbl": {"shape": "table/v1"} },
      "value": {"kind": "tbl", "columns": [{"header": "N"}], "rows": [["a"], ["b"]]},
    });
    let out = reg.render(&u, 40, &ctx).expect("dispatches");
    assert!(out.lines.iter().any(|l| l.contains('a')), "{:?}", out.lines);
    assert!(
      !out.lines[0].contains("union/v1:"),
      "should render, not diagnose"
    );

    // A bare dispatch spec (no `value`) degrades gracefully.
    let bare = json!({"shape": "union/v1", "by": "kind", "variants": {}});
    let out = reg.render(&bare, 40, &ctx).expect("dispatches");
    assert!(out.lines[0].contains("no value"), "{}", out.lines[0]);
  }
}
