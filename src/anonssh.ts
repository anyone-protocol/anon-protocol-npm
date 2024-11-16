import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Anon } from './anon';

interface AnonProxyConfig {
    host: string;
    socksPort: number;
}

export class AnonSSH {
    private anon?: Anon;
    private socksPort: number;
    private host: string;
    
    constructor(anon: Anon);
    constructor(config: AnonProxyConfig);
    constructor(anonOrConfig: Anon | AnonProxyConfig) {
        if (anonOrConfig instanceof Anon) {
            this.anon = anonOrConfig;
            this.socksPort = this.anon.getSOCKSPort();
            this.host = 'localhost';
        } else {
            this.socksPort = anonOrConfig.socksPort;
            this.host = anonOrConfig.host;
        }

        if (this.socksPort === 0) {
            throw new Error('SOCKS port has value 0, and is therefore disabled.\n' +
                'SOCKS proxy must be enabled with a valid port number (1-65535) to use the SOCKS client');
        }
    }
    

    
}