import type { IConnector } from "../../i-connector.js"
import { Pod, type ClusterConfig, type PodStatus } from "../../types.js"

// https://graphql-spec.runpod.io/#definition-PodStatus
const STATUS_MAP: Record<string, PodStatus> = {
    CREATED: "starting",
    RUNNING: "grey",
    RESTARTING: "restarting",
    EXITED: "unhealthy",
    PAUSED: "unhealthy",
    DEAD: "unhealthy",
    TERMINATED: "unhealthy",
}

export class RunPodConnector implements IConnector {
    private apiKey: string

    constructor(apiKey: string) {
        this.apiKey = apiKey
    }

    private async call<T>(query: string, variables = {}) {
        const response = await fetch(
            `https://api.runpod.io/graphql?api_key=${this.apiKey}`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    query,
                    variables,
                }),
            },
        )

        if (!response.ok) {
            const text = await response.text()
            throw new Error(
                `${response.status} - ${response.statusText} - ${text}`,
            )
        }

        const json = (await response.json()) as {
            data: T
            errors?: { message: string }[]
        }

        console.log(JSON.stringify(json, null, 4))

        if (json.errors) {
            throw new Error(JSON.stringify(json.errors, null, 4))
        }

        return json.data
    }

    async getPod(podId: string) {
        return await this.call<{
            pod: {
                id: string
                desiredStatus: string
                name: string
                imageName: string
                containerDiskInGb: number
                volumeInGb: number
            }
        }>(`
                 query someQuery {
                    pod(
                        input: {
                            podId: "${podId}"
                        }
                    ) {
                        id
                        desiredStatus
                        name
                        imageName
                        containerDiskInGb
                        volumeInGb
                    }
                    }`)
    }

    async getStatus(pod: Pod) {
        const rpPod = await this.getPod(pod.id)
        return STATUS_MAP[rpPod.pod.desiredStatus]
    }

    async load(names: string[]) {
        const pods = await this.call<{
            myself: {
                pods: {
                    name: string
                    id: string
                    desiredStatus: string
                    imageName: string
                    containerDiskInGb: number
                    volumeInGb: number
                }[]
            }
        }>(`
            query someQuery {
                myself {
                    pods {
                        id
                        name
                        desiredStatus
                        imageName
                        containerDiskInGb
                        volumeInGb
                    }
                }
            }
            `)

        return names.map((name) => {
            return {
                name,
                pods: pods.myself.pods
                    .filter((pod) => pod.name === `gingo-${name}`)
                    .map((pod) => {
                        const thePod = new Pod(pod.id)
                        thePod.status = STATUS_MAP[pod.desiredStatus]
                        thePod.extra = {
                            imageName: pod.imageName,
                            containerDiskInGb: pod.containerDiskInGb,
                            volumeInGb: pod.volumeInGb,
                        }
                        return thePod
                    }),
            }
        })
    }

    async add(clusterConfig: ClusterConfig) {
        const out = await this.call<{
            podFindAndDeployOnDemand: {
                id: string
                imageName: string
                containerDiskInGb: number
                volumeInGb: number
            }
        }>(
            `
            mutation someMutation($input: PodFindAndDeployOnDemandInput) {
                podFindAndDeployOnDemand(input: $input) {
                    id
                    imageName
                    containerDiskInGb
                    volumeInGb
                }
            }
            `,
            {
                input: {
                    name: "gingo-" + clusterConfig.id,
                    ...clusterConfig.connectorAdd,

                    // cloudType: "SECURE",
                    // containerDiskInGb: 20,
                    // volumeInGb: 20,
                    // gpuCount: 1,
                    // gpuTypeId: "NVIDIA RTX 2000 Ada Generation",
                    // minMemoryInGb: 31,
                    // minVcpuCount: 6,
                    // templateId: "runpod-torch-v21",
                    // ports: "8888/http,22/tcp",
                    // startJupyter: false,
                    // startSsh: false,
                    // volumeKey: null,
                    // dataCenterId: null,
                    // networkVolumeId: null,
                },
            },
        )

        const podDeets = out.podFindAndDeployOnDemand

        const newPod = new Pod(podDeets.id)

        newPod.extra = {
            imageName: podDeets.imageName,
            containerDiskInGb: podDeets.containerDiskInGb,
            volumeInGb: podDeets.volumeInGb,
        }

        return newPod
    }

    async remove(pod: Pod) {
        await this.call(
            `
            mutation someMutation($input: PodTerminateInput!) {
                podTerminate(input: $input)
            } 
            `,
            {
                input: {
                    podId: pod.id,
                },
            },
        )
    }

    async restart(pod: Pod) {
        await this.call(
            `
             mutation someMutation($input: PodEditJobInput!) {
                podEditJob(input: $input) {
                    id
                }
            } 
            `,
            {
                input: {
                    podId: pod.id,
                    imageName: pod.extra.imageName,
                    containerDiskInGb: pod.extra.containerDiskInGb,
                    volumeInGb: pod.extra.volumeInGb,
                },
            },
        )
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const rp = new RunPodConnector(process.env.RP!)

    // await rp.load([])

    // await rp.remove({
    //     id: "1huufye5wjfd1j",
    // } as Pod)

    // await rp.getPod("3pk84cd2ryq922")

    // await rp.restart({
    //     id: "3pk84cd2ryq922",
    //     extra: {
    //         imageName: "runpod/base:0.5.1-cpu",
    //         containerDiskInGb: 5,
    //         volumeInGb: 0,
    //     },
    // } as unknown as Pod)

    // await rp.add({
    //     id: "a",
    //     connectorAdd: {},
    // } as unknown as ClusterConfig)
}
