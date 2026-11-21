// Remotion CLI config. Kept minimal: one render at a time (GitHub Actions has
// 2 CPUs and a history of exit-143 OOM kills), no telemetry-style extras.
import { Config } from "@remotion/cli/config";

Config.setConcurrency(1);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
