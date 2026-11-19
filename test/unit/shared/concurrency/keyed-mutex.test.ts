import { describe, expect, test } from "bun:test";
import { KeyedMutex } from "../../../../src/shared/concurrency/keyed-mutex.ts";

const timeoutError = () => new Error("timeout");

describe("KeyedMutex", () => {
  test("mesma chave: uma de cada vez, em ordem de chegada", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    let running = 0;
    let maxRunning = 0;
    const task = (name: string) => async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      log.push(`start ${name}`);
      await Bun.sleep(10);
      log.push(`end ${name}`);
      running--;
    };
    await Promise.all(["a", "b", "c"].map((n) => mutex.run("w1", 1_000, timeoutError, task(n))));
    expect(maxRunning).toBe(1);
    expect(log).toEqual(["start a", "end a", "start b", "end b", "start c", "end c"]);
    expect(mutex.size).toBe(0); // fila vazia some do mapa
  });

  test("chaves diferentes rodam em paralelo", async () => {
    const mutex = new KeyedMutex();
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await Bun.sleep(20);
      running--;
    };
    await Promise.all(["w1", "w2", "w3"].map((k) => mutex.run(k, 1_000, timeoutError, task)));
    expect(maxRunning).toBe(3);
  });

  test("esperou demais: lança o erro de timeout sem executar a tarefa", async () => {
    const mutex = new KeyedMutex();
    let executed = false;
    const slow = mutex.run("w1", 1_000, timeoutError, () => Bun.sleep(100));
    const impatient = mutex.run("w1", 20, timeoutError, async () => {
      executed = true;
    });
    await expect(impatient).rejects.toThrow("timeout");
    await slow;
    expect(executed).toBe(false);
  });

  test("quem desistiu por timeout não deixa o próximo furar a fila de quem ainda está rodando", async () => {
    const mutex = new KeyedMutex();
    const log: string[] = [];
    const first = mutex.run("w1", 1_000, timeoutError, async () => {
      log.push("first start");
      await Bun.sleep(80);
      log.push("first end");
    });
    const gaveUp = mutex.run("w1", 10, timeoutError, async () => {
      log.push("gave-up ran");
    });
    const third = mutex.run("w1", 1_000, timeoutError, async () => {
      log.push("third start");
    });
    await expect(gaveUp).rejects.toThrow("timeout");
    await Promise.all([first, third]);
    expect(log).toEqual(["first start", "first end", "third start"]);
  });

  test("erro na tarefa libera a vez para o próximo", async () => {
    const mutex = new KeyedMutex();
    const failing = mutex.run("w1", 1_000, timeoutError, async () => {
      throw new Error("boom");
    });
    await expect(failing).rejects.toThrow("boom");
    expect(await mutex.run("w1", 1_000, timeoutError, async () => "ok")).toBe("ok");
    expect(mutex.size).toBe(0);
  });
});
