import { expect, test } from "@playwright/test";

test("home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "PipeHeal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeDisabled();
});

test("health endpoint reports the web service up", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ok", service: "web" });
});
