#!/bin/sh
# Calls an MCP tool over streamable HTTP and prints the text result. Handy for testing
# the engine and registry without Claude Code.
#
#   tools/mcp.sh engine   find_recipe '{"request":"revenue projection"}'
#   tools/mcp.sh registry search_capabilities '{"query":"convert to USD"}'
#   RECIPE_ENGINE_TOKEN=dev-lead-token tools/mcp.sh engine approve_step '{...}'   (act as another user)
set -eu
case "$1" in
  engine) url="http://localhost:7400/mcp" ;;
  registry) url="http://localhost:7300/mcp" ;;
  *) url="$1" ;;
esac
tool="$2"
args="${3:-{\}}"
resp=$(curl -s -X POST "$url" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -H "authorization: Bearer ${RECIPE_ENGINE_TOKEN:-dev-analyst-token}" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}")
case "$resp" in
  *"data: "*) ;;
  *) echo "$resp" >&2; exit 1 ;;
esac
printf '%s\n' "$resp" | sed -n 's/^data: //p' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.error){console.error(JSON.stringify(r.error));process.exit(1)}const t=r.result.content.map(c=>c.text).join("\n");console.log(t);if(r.result.isError)process.exit(1)})'
