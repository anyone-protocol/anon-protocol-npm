import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Anon } from './anon';

export class AnonSocksClient {
  private anon?: Anon;
  private agent: SocksProxyAgent;
  public axios: AxiosInstance;
  private socksPort: number;

  constructor(anon: Anon);
  constructor(socksPort: number);
  constructor(anonOrPort: Anon | number) {
    if (anonOrPort instanceof Anon) {
      this.anon = anonOrPort;
      this.socksPort = this.anon.getSOCKSPort();
    } else {
      this.socksPort = anonOrPort;
    }

    if (this.socksPort === 0) {
      throw new Error('Invalid SOCKS port: 0. SOCKS proxy must be enabled with a valid port number (1-65535).');
    }
    
    this.agent = this.createAgent();
    this.axios = axios.create({
      httpAgent: this.agent,
      httpsAgent: this.agent
    });
  }

  private createAgent(): SocksProxyAgent {
    return new SocksProxyAgent(`socks://127.0.0.1:${this.socksPort}`);
  }

  public get<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.get(url, config);
  }

  public post<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.post(url, data, config);
  }

  public put<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.put(url, data, config);
  }

  public delete<T = any>(url: string, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.delete(url, config);
  }

  public patch<T = any>(url: string, data?: any, config?: AxiosRequestConfig): Promise<AxiosResponse<T>> {
    return this.axios.patch(url, data, config);
  }

}