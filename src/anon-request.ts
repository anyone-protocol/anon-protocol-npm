import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { Anon } from './anon';

export class AnonRequest {
  private anon: Anon;
  private agent: SocksProxyAgent;
  public axios: AxiosInstance;

  constructor(anon: Anon) {
    this.anon = anon;
    this.agent = this.createAgent();
    this.axios = axios.create({
      httpAgent: this.agent,
      httpsAgent: this.agent
    });
  }

  private createAgent(): SocksProxyAgent {
    const socksPort = this.anon.getSOCKSPort() || 9050;
    return new SocksProxyAgent(`socks://127.0.0.1:${socksPort}`);
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