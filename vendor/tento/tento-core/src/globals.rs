// todo: handle visibility

#[macro_export]
macro_rules! symbols {
  ($module_name:ident, { $( $key:expr => $value:expr ),* $(,)? } ) => {
    pub mod $module_name {
      static KEY_TO_VALUE: tento_core::phf::Map<&'static str, &'static str> = tento_core::phf::phf_map! {
          $( $key => $value ),*
      };
      static VALUE_TO_KEY: tento_core::phf::Map<&'static str, &'static str> = tento_core::phf::phf_map! {
          $( $value => $key ),*
      };

      #[inline]
      pub fn value(key: &str) -> Option<&'static str> {
        KEY_TO_VALUE.get(key).map(|v| *v)
      }

      #[inline]
      pub fn key(value: &str) -> Option<&'static str> {
        VALUE_TO_KEY.get(value).map(|k| *k)
      }
    }
  };
}
