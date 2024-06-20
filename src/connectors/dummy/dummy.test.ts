import { DummyConnector } from "./dummy.js"
import { Gingo } from "../../gingo.js"

const dummyConnector = new DummyConnector()

const gingo = new Gingo({
    config: {
        global: {},
        clusters: [
            {
                id: "chat",
                checkPodHealth: async (podId) => {
                    const mockOk = Math.random() > 0.75
                    // const mockOk = false
                    console.info({ podId, mockOk })
                    return mockOk
                },
                onPodListUpdate: async (podIds) => {
                    console.info({ podIds })
                },
                checkIntervalMin: 1,
                checkTimeoutS: 10,
                healthyCheckCount: 3,
                unhealthyCheckCount: 3,
                targetPodCount: 2,
                restartCountToDrop: 1,
                connectorAdd: {},
            },
        ],
    },
    connector: dummyConnector,
})

await gingo.start()
