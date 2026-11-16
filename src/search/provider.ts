export type SearchDepth = "basic" | "advanced";

export interface SearchRequest {
  readonly query: string;
  readonly max_results: number;
  readonly search_depth: SearchDepth;
  readonly include_domains?: readonly string[];
  readonly exclude_domains?: readonly string[];
  readonly provider: string;
}

export interface SearchResultItem {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly published_date: string | null;
  readonly score: number | null;
  readonly provider: string;
}

export interface RawSearchExecutionResult {
  readonly provider: string;
  readonly results: readonly SearchResultItem[];
  readonly creditsUsed: number;
  readonly upstreamStatus?: number;
}

export interface SearchProviderCapabilities {
  readonly supportsDomainFilter: boolean;
  readonly supportsSearchDepth: boolean;
  readonly supportsFreshness: boolean;
}

export interface SearchProviderEnv {
  readonly TAVILY_API_KEY?: string;
  readonly EXA_API_KEY?: string;
  readonly BRAVE_API_KEY?: string;
  readonly PARALLEL_API_KEY?: string;
  readonly LINKUP_API_KEY?: string;
  readonly PRIMARY_SEARCH_PROVIDER?: string;
  readonly [key: string]: string | undefined;
}

export interface SearchProvider {
  readonly id: string;
  readonly name: string;
  readonly requiresCreditCard: boolean;
  readonly capabilities: SearchProviderCapabilities;
  estimateCost(req: SearchRequest): number;
  search(
    req: SearchRequest,
    env: SearchProviderEnv,
    signal: AbortSignal,
  ): Promise<RawSearchExecutionResult>;
}

export interface SearchProviderRegistration {
  readonly id: string;
  readonly secretKey: keyof SearchProviderEnv;
  readonly factory: (apiKey: string, env: SearchProviderEnv) => SearchProvider;
}
