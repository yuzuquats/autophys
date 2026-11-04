/*
 Decorators
 ===============================================================================
*/
let _component = (config: { name: string }): ClassDecorator => {
  return (ctr: Function) => {
    // This is where the class/tag bijection is established, and it is the only
    // place it can be established. The registry keeps its first definition
    // permanently — elements already in the document were upgraded against it
    // — so a second class for a name can never take effect. Skipping and
    // warning, which is what this used to do, left the dropped class inert
    // forever while its callers held a reference that looked perfectly good.
    // That is how a storybook card came to render the app's component instead
    // of the one in the diff beside it, with nothing in the console to say so.
    //
    // Throwing is the contract, not a diagnostic: a document must never hold
    // two builds of the same component. Anything that needs a second build
    // gets a second document, which has its own registry.
    //
    // `make()` depends on this holding. It constructs the class directly
    // instead of resolving the tag, because once this has run there is nothing
    // else the tag can resolve to.
    if (window.customElements.get(config.name) != null) {
      throw new Error(
        `@component({ name: "${config.name}" }): that name is already ` +
          "registered to another class. A custom element name can only ever " +
          "have one constructor, so this document is holding two builds of " +
          "the same component — give the second one its own document.",
      );
    }
    ctr["componentName"] = config.name;
    window.customElements.define(config.name, ctr as CustomElementConstructor);
  };
};

export let component = globalThis["disable-dom"] ? () => () => {} : _component;
