# 0.2.1

Preserve streamed assistant text at terminal delivery and use only the final
assistant message as a fallback. Replay now requires and validates its expected
run ID, while the reducer ignores events for another active run. Error-valued
tool results render as failed instead of completed.

# 0.2.0

Moved from standalone lazy-agent-chat revision 284a06a. The five source files and
original eight tests were compared byte-for-byte before changes. Runtime event
types now derive from the repository's generated wire schema. Built declarations
and contract identity ship with the versioned npm artifact.

Replay is deduplicated per run. Cancellation remains pending until the runtime
seals the run. Unknown events remain observable. Applications retain credentials,
transport admission, domain authorization, mutations, persistence and UI layout.
