export type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number;
  webhooks?: {
    onJobStart?: string;
    onJobComplete?: string;
    headers?: Record<string, string>;
  };
};
