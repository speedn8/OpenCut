import { afterEach, describe, expect, test } from "bun:test";
import { IndexedDBAdapter } from "../src/services/storage/indexeddb-adapter";

type Handler = (() => void) | null;
type Operation = "set" | "remove" | "clear";

const originalIndexedDB = Object.getOwnPropertyDescriptor(globalThis, "indexedDB");

afterEach(() => {
	if (originalIndexedDB) {
		Object.defineProperty(globalThis, "indexedDB", originalIndexedDB);
	} else {
		Reflect.deleteProperty(globalThis, "indexedDB");
	}
});

// Control request and transaction events separately. IndexedDB may report a
// successful put/delete/clear before aborting the transaction that contains it.
function fixture({ enqueueError }: { enqueueError?: Error } = {}) {
	const request = {
		error: null as DOMException | null,
		onerror: null as Handler,
		onsuccess: null as Handler,
	};
	const calls: { operation: Operation; argument?: unknown }[] = [];
	let signalStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		signalStarted = resolve;
	});
	function enqueue(operation: Operation, argument?: unknown) {
		if (enqueueError) throw enqueueError;
		calls.push({ operation, argument });
		signalStarted();
		return request;
	}
	const transaction = {
		error: null as DOMException | null,
		oncomplete: null as Handler,
		onerror: null as Handler,
		onabort: null as Handler,
		objectStore(name: string) {
			expect(name).toBe("projects");
			return {
				put: (value: unknown) => enqueue("set", value),
				delete: (key: string) => enqueue("remove", key),
				clear: () => enqueue("clear"),
			};
		},
	};
	const openRequest = {
		error: null,
		onerror: null as Handler,
		onsuccess: null as Handler,
		onupgradeneeded: null as Handler,
		result: {
			transaction(names: string[], mode: IDBTransactionMode) {
				expect(names).toEqual(["projects"]);
				expect(mode).toBe("readwrite");
				return transaction;
			},
		},
	};
	Object.defineProperty(globalThis, "indexedDB", {
		configurable: true,
		value: {
			open(name: string, version: number) {
				expect(name).toBe("test-db");
				expect(version).toBe(1);
				return openRequest;
			},
		},
	});
	const adapter = new IndexedDBAdapter<{ name: string }>({
		dbName: "test-db",
		storeName: "projects",
	});
	function run(operation: Operation) {
		const result =
			operation === "set"
				? adapter.set({ key: "project-1", value: { name: "Timeline" } })
				: operation === "remove"
					? adapter.remove("project-1")
					: adapter.clear();
		openRequest.onsuccess?.();
		return result;
	}
	return { request, transaction, calls, started, run };
}

describe("IndexedDB write durability", () => {
	for (const operation of ["set", "remove", "clear"] as const) {
		test(`${operation} stays pending after request success and resolves on commit`, async () => {
			const f = fixture();
			let settled = false;
			const result = f.run(operation).finally(() => {
				settled = true;
			});
			await f.started;
			expect(f.calls).toEqual([
				{
					operation,
					argument:
						operation === "set"
							? { id: "project-1", name: "Timeline" }
							: operation === "remove"
								? "project-1"
								: undefined,
				},
			]);
			f.request.onsuccess?.();
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			expect(settled).toBe(false);
			expect(f.transaction.oncomplete).toBeFunction();
			f.transaction.oncomplete?.();
			await result;
			expect(settled).toBe(true);
		});

		test(`${operation} rejects when a successful request is followed by transaction abort`, async () => {
			const f = fixture();
			const result = Promise.allSettled([f.run(operation)]);
			await f.started;
			f.request.onsuccess?.();
			const error = new DOMException("Commit was aborted", "AbortError");
			f.transaction.error = error;
			f.transaction.onabort?.();
			expect(await result).toEqual([{ status: "rejected", reason: error }]);
		});
	}

	test("propagates transaction errors after request success", async () => {
		const f = fixture();
		const result = Promise.allSettled([f.run("set")]);
		await f.started;
		f.request.onsuccess?.();
		const error = new DOMException("Disk quota exceeded", "QuotaExceededError");
		f.transaction.error = error;
		f.transaction.onerror?.();
		expect(await result).toEqual([{ status: "rejected", reason: error }]);
	});

	test("propagates the original write request error", async () => {
		const f = fixture();
		const result = Promise.allSettled([f.run("set")]);
		await f.started;
		const error = new DOMException("Invalid project key", "DataError");
		f.request.error = error;
		f.request.onerror?.();
		f.transaction.onabort?.();
		expect(await result).toEqual([{ status: "rejected", reason: error }]);
	});

	test("an explicit abort with no database error still rejects with an Error", async () => {
		const f = fixture();
		const result = Promise.allSettled([f.run("remove")]);
		await f.started;
		f.transaction.onabort?.();
		expect(await result).toEqual([
			{
				status: "rejected",
				reason: new Error("IndexedDB write transaction aborted"),
			},
		]);
	});

	test("rejects synchronous errors while enqueueing a write", async () => {
		const error = new DOMException("Object store was deleted", "InvalidStateError");
		const f = fixture({ enqueueError: error });
		expect(await Promise.allSettled([f.run("clear")])).toEqual([
			{ status: "rejected", reason: error },
		]);
	});
});
