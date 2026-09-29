// Runs before every integration test file: local docker compose services (loopback) only.
import { installNetworkGuard } from "@pipeheal/shared/testing";

installNetworkGuard("loopback-only");
