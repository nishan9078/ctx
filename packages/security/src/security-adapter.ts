export interface SecurityFinding { id: string; title: string; severity: 'critical' | 'high' | 'medium' | 'low' | 'informational'; file?: string; line?: number }
export interface SecurityResult {
  status: 'passed' | 'findings' | 'unavailable' | 'error' | 'cancelled'; findings: SecurityFinding[];
  coverage: string[]; limitations: string[]; reportPath?: string;
}
export interface SecurityAdapter {
  scan(input: { repositoryPath: string; outputDirectory: string; changesOnly?: boolean; signal?: AbortSignal; onProgress?: (message: string) => void }): Promise<SecurityResult>;
}
