import { expect, test } from "@playwright/test";

test("a signed-out visitor of an org page is sent to sign-in, and back afterwards", async ({
  page,
}) => {
  await page.goto("/acme/repos?tab=all");

  await expect(page).toHaveURL(/\/login\?next=%2Facme%2Frepos%3Ftab%3Dall$/);
  await expect(page.getByRole("heading", { name: "Sign in to PipeHeal" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeEnabled();
  await expect(page.locator('input[name="next"]')).toHaveValue("/acme/repos?tab=all");
});

test("a signed-out visitor of a repo's workflow picker is sent to sign-in, and back afterwards", async ({
  page,
}) => {
  await page.goto("/acme/repos/00000000-0000-0000-0000-000000000000");

  await expect(page).toHaveURL(
    /\/login\?next=%2Facme%2Frepos%2F00000000-0000-0000-0000-000000000000$/,
  );
});

test("a signed-out visitor of onboarding is sent to sign-in, and back afterwards", async ({
  page,
}) => {
  await page.goto("/onboarding");

  await expect(page).toHaveURL(/\/login\?next=%2Fonboarding$/);
});

test("a signed-out visitor of the post-install callback is sent to sign-in, keeping the query", async ({
  page,
}) => {
  await page.goto("/onboarding/installed?installation_id=123&setup_action=install");

  await expect(page).toHaveURL(
    /\/login\?next=%2Fonboarding%2Finstalled%3Finstallation_id%3D123%26setup_action%3Dinstall$/,
  );
});

for (const next of ["//evil.example/steal", "/.//evil.example", "/%2e%2e//evil.example"]) {
  test(`sign-in never sends the user to another site afterwards (next=${next})`, async ({
    page,
  }) => {
    await page.goto(`/login?next=${encodeURIComponent(next)}`);

    await expect(page.locator('input[name="next"]')).toHaveValue("/");
  });
}

test("a forged session cookie gets past the proxy but not the org layout", async ({
  page,
  context,
  baseURL,
}) => {
  await context.addCookies([
    { name: "pipeheal.session_token", value: "forged.value", url: baseURL ?? "" },
  ]);

  await page.goto("/acme");

  await expect(page).toHaveURL(/\/login\?next=%2Facme$/);
});

test("Better Auth reports no session for a signed-out visitor", async ({ request }) => {
  const response = await request.get("/api/auth/get-session");

  expect(response.status()).toBe(200);
  expect(await response.json()).toBeNull();
});
