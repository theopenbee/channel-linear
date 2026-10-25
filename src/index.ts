import { defineChannel } from "@theopenbee/channel-sdk";

import { createLinearChannel } from "./linear.js";

defineChannel(createLinearChannel());
