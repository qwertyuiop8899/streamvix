export function normTeam(name: string): string;
export function teamAliases(name: string): Set<string>;
export function extractTeams(title: string): [string|null,string|null];
export function isSingleEntity(title: string): boolean;
