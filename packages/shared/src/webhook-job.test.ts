import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import { webhookJobDataSchema } from "./webhook-job";

describe("webhookJobDataSchema", () => {
  it("accepts a job with an action and an arbitrary payload", () => {
    const data = {
      deliveryId: "72d3162e-cc78-11e3-81ab-4c9367dc0958",
      event: "installation",
      action: "created",
      payload: { installation: { id: 1 } },
    };
    expect(webhookJobDataSchema.parse(data)).toEqual(data);
  });

  it("accepts a job with no action (e.g. ping)", () => {
    expect(
      webhookJobDataSchema.parse({ deliveryId: "x", event: "ping", payload: { zen: "..." } }),
    ).toMatchObject({ event: "ping" });
  });

  it.each([
    ["an empty delivery id", { deliveryId: "", event: "ping", payload: {} }],
    ["a missing event", { deliveryId: "x", payload: {} }],
    ["a missing payload", { deliveryId: "x", event: "ping" }],
  ])("rejects %s", (_label, data) => {
    expect(() => webhookJobDataSchema.parse(data)).toThrow(ZodError);
  });
});
