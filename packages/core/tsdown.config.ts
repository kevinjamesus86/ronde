import { packageConfig } from "../tsdown.shared.js"

export default packageConfig({
  entry: {
    index: "src/index.ts",
    tool: "src/tool.ts",
    result: "src/result.ts",
    message: "src/message.ts",
    completion: "src/completion.ts",
    journal: "src/journal.ts",
    workspace: "src/workspace.ts",
    block: "src/block.ts",
    runtime: "src/runtime.ts",
    toolkit: "src/toolkit.ts",
    stream: "src/stream.ts",
    tokens: "src/tokens.ts",
    bytes: "src/bytes.ts",
    id: "src/id.ts",
  },
})
