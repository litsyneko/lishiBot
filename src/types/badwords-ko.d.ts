declare module 'badwords-ko' {
  export interface FilterOptions {
    readonly emptyList?: boolean
    readonly list?: readonly string[]
    readonly exclude?: readonly string[]
    readonly splitRegex?: RegExp
    readonly placeHolder?: string
    readonly regex?: RegExp
    readonly replaceRegex?: RegExp
  }

  export type Filter = {
    isProfane(string: string): boolean
    clean(string: string): string
    addWords(...words: string[]): void
    removeWords(...words: string[]): void
  }

  const Filter: new (options?: FilterOptions) => Filter
  export default Filter
}

declare module 'badwords-ko/src/badwords.ko.config.json' {
  export const badWords: readonly string[]
}
