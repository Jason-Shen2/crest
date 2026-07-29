// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

interface SessionIdMutationFence {
	pending: number;
	tail: Promise<void>;
}

const SessionIdMutationFences = new Map<string, SessionIdMutationFence>();

export function withSessionIdMutationFence<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
	let fence = SessionIdMutationFences.get(sessionId);
	if (!fence) {
		fence = { pending: 0, tail: Promise.resolve() };
		SessionIdMutationFences.set(sessionId, fence);
	}
	fence.pending++;
	const previous = fence.tail;
	const result = previous.then(operation);
	fence.tail = result.then(
		() => undefined,
		() => undefined
	);
	return result.finally(() => {
		fence!.pending--;
		if (fence!.pending === 0 && SessionIdMutationFences.get(sessionId) === fence) {
			SessionIdMutationFences.delete(sessionId);
		}
	});
}
