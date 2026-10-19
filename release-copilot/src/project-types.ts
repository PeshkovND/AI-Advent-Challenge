export type Project = { id: string; name: string; root: string }
export type FolderListing = { path: string; parent: string | null; home: string; directories: string[]; truncated: boolean }
