import { TypedApi } from "@tento-core/typed-api";
import { Network } from "@tento-web/auth/auth-routes";

export const AuthApi = TypedApi.makeWith<Network.Routes>(
  Network.REVIVERS,
);
