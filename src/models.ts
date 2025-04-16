
export interface VPNConfig {
    routings: VPNRouting[];
}

export interface VPNRouting {
    targetAddress: string;
    exitCountries: string[];
}

