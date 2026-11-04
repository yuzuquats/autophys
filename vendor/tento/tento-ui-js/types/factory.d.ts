declare type Factory<T> = () => T;

declare interface ComponentFactory<TInstance, TProps, TDelegate = void> {
  make(
    props: TProps,
    ...delegate: TDelegate extends void ? [] : [TDelegate]
  ): TInstance;
  bind(
    instance: TInstance,
    props: TProps,
    ...delegate: TDelegate extends void ? [] : [TDelegate]
  ): TInstance;
}
