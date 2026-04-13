export type AutodevAgentConfig = {
  agentId: string;
  model: string;
  apiKey: string;
};

export type AutodevConfig = {
  enabled?: boolean;
  bridgeUrl?: string;
  httpSecret?: string;
  ciFixMaxRetries?: number;
  github?: {
    appId: string;
    privateKeyPath: string;
    repoOwner: string;
    repoName: string;
    installationId: string;
    webhookSecret: string;
  };
  agents?: {
    facilitator: AutodevAgentConfig;
    cko: AutodevAgentConfig;
    pm: AutodevAgentConfig;
    arch: AutodevAgentConfig;
    coder: AutodevAgentConfig;
    validator: AutodevAgentConfig;
  };
  models?: {
    mode?: string;
    providers?: Record<
      string,
      {
        baseUrl?: string;
        models?: unknown[];
      }
    >;
  };
  env?: {
    vars?: Record<string, string>;
  };
};

/** Named agent map under `autodev.agents` (facilitator, pm, arch, etc.). */
export type AutodevAgentsConfig = NonNullable<AutodevConfig["agents"]>;
