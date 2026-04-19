//#region packages/core/src/journal.ts
const JournalEvent = {
	message(message) {
		return {
			type: "message",
			message
		};
	},
	turnEnd(turn, usage, stopReason) {
		return {
			type: "turn_end",
			turn,
			usage,
			stopReason
		};
	},
	compactionStart(turn, historyLength) {
		return {
			type: "compaction_start",
			turn,
			historyLength
		};
	},
	compactionEnd(turn, usage) {
		return {
			type: "compaction_end",
			turn,
			usage
		};
	},
	cutoff(turn, count) {
		return {
			type: "cutoff",
			turn,
			count
		};
	},
	warning(turn, message) {
		return {
			type: "warning",
			turn,
			message
		};
	},
	error(turn, message) {
		return {
			type: "error",
			turn,
			message
		};
	},
	runEnd(settleReason, totals) {
		return {
			type: "run_end",
			settleReason,
			totals
		};
	}
};
/**
* Ordered durable event history for replay, audit, and resume.
* Implementations may be fs-backed, in-memory, remote, or custom.
*/
var Journal = class {
	/**
	* Mark the current active slice as a durable resume point.
	*
	* Semantically: when this resolves, all events appended before the
	* call are on stable storage; a crash afterward can recover from
	* this point. The engine calls `commit()` at natural checkpoints
	* (turn_end, run_end) so resume lands at a coherent boundary.
	*
	* Implementations may no-op when their `event()` path is already
	* synchronous-on-disk, or when durability isn't a concern (memory
	* journal). Implementations that buffer appends must flush here.
	*/
	async commit() {}
};
//#endregion
export { Journal, JournalEvent };

//# sourceMappingURL=journal.mjs.map