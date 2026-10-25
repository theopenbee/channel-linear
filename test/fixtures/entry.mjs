import { defineChannel } from "@theopenbee/channel-sdk";

import { createLinearChannel } from "../../dist/linear.js";

const [endpoint, assetPrefix, legacyDir] = process.argv.slice(2);
defineChannel(createLinearChannel({ endpoint, assetPrefix, legacyDir }));
