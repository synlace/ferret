declare module "react-syntax-highlighter" {
  import { ComponentType, CSSProperties } from "react"

  interface SyntaxHighlighterProps {
    language?: string
    style?: Record<string, CSSProperties>
    customStyle?: CSSProperties
    useInlineStyles?: boolean
    showLineNumbers?: boolean
    lineNumberStyle?: CSSProperties | ((lineNumber: number) => CSSProperties)
    wrapLines?: boolean
    wrapLongLines?: boolean
    children: string
    [key: string]: unknown
  }

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps> & {
    registerLanguage: (name: string, language: unknown) => void
  }
  export default SyntaxHighlighter

  export const Light: typeof SyntaxHighlighter
}

declare module "react-syntax-highlighter/dist/esm/styles/hljs/atom-one-dark" {
  import { CSSProperties } from "react"
  const style: Record<string, CSSProperties>
  export default style
}

declare module "react-syntax-highlighter/dist/esm/languages/hljs/http" {
  const language: unknown
  export default language
}

declare module "react-syntax-highlighter/dist/esm/languages/hljs/json" {
  const language: unknown
  export default language
}

declare module "react-syntax-highlighter/dist/esm/languages/hljs/xml" {
  const language: unknown
  export default language
}

declare module "react-syntax-highlighter/dist/esm/languages/hljs/css" {
  const language: unknown
  export default language
}

declare module "react-syntax-highlighter/dist/esm/languages/hljs/javascript" {
  const language: unknown
  export default language
}

declare module "react-syntax-highlighter/dist/esm/languages/hljs/plaintext" {
  const language: unknown
  export default language
}
