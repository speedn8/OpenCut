import { afterAll, expect, test } from "bun:test";
const originals = new Map(["window", "location", "history"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const surface = new EventTarget();
const locationFixture = { pathname: "/editor/one" };
const historyFixture = {
  pushState(_state: unknown, _title: string, path: string) { locationFixture.pathname = path; },
  replaceState(_state: unknown, _title: string, path: string) { locationFixture.pathname = path; },
  back() {},
};
Object.defineProperty(globalThis,"window",{configurable:true,value:surface});
Object.defineProperty(globalThis,"location",{configurable:true,value:locationFixture});
Object.defineProperty(globalThis,"history",{configurable:true,value:historyFixture});
const { studioRouter, setNavigationGuard } = await import("../src/studio/navigation");
afterAll(() => {for(const [key,descriptor] of originals){if(descriptor)Object.defineProperty(globalThis,key,descriptor);else Reflect.deleteProperty(globalThis,key);}});

test("navigation waits for save before committing the new route", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => release = resolve);
  const clear = setNavigationGuard(() => pending);
  const navigation = studioRouter.push("/projects");
  expect(locationFixture.pathname).toBe("/editor/one");
  release();expect(await navigation).toBe(true);
  expect(locationFixture.pathname).toBe("/projects");clear();
});

test("failed save leaves the editor route intact", async () => {
  await studioRouter.replace("/editor/one");
  const clear = setNavigationGuard(async () => {throw new Error("Storage full");});
  expect(await studioRouter.push("/projects")).toBe(false);
  expect(locationFixture.pathname).toBe("/editor/one");clear();
});

test("failed save restores a history navigation without changing the editor", async () => {
  const clear = setNavigationGuard(async () => {throw new Error("Storage full");});
  locationFixture.pathname="/projects";
  surface.dispatchEvent(new Event("popstate"));
  await new Promise(resolve=>setTimeout(resolve,0));
  expect(locationFixture.pathname).toBe("/editor/one");clear();
});

test("a second navigation cannot race a pending save barrier", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => release = resolve);
  const clear = setNavigationGuard(() => pending);
  const first = studioRouter.push("/projects");
  expect(await studioRouter.push("/editor/two")).toBe(false);
  release();expect(await first).toBe(true);
  expect(locationFixture.pathname).toBe("/projects");clear();
});
