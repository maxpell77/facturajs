import moment from 'moment';
import * as soap from 'soap';
import { IConfigService } from '../IConfigService';
import { WsServicesNames } from '../SoapMethods';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
const s3Client = new S3Client({ region: process.env.AWS_REGION });
import {
    debug,
    LOG,
    parseXml,
    readStringFromFile,
    signMessage,
    writeFile,
} from '../util';
import { NtpTimeSync } from 'ntp-time-sync';

type SoapServiceAlias = {
    [K in WsServicesNames]?: WsServicesNames;
};

interface ICredential {
    tokens: {
        token: string;
        sign: string;
    };
    created: string;
    service: WsServicesNames;
}

type ICredentialsCache = {
    [K in WsServicesNames]?: ICredential;
};

export class AfipSoap {
    private tokensAliasServices: SoapServiceAlias = {
        wsfev1: 'wsfe',
    };
    private urls = {
        homo: {
            login: 'https://wsaahomo.afip.gov.ar/ws/services/LoginCms?wsdl',
            service: 'https://wswhomo.afip.gov.ar/{name}/service.asmx?wsdl',
        },
        prod: {
            login: 'https://wsaa.afip.gov.ar/ws/services/LoginCms?wsdl',
            service: 'https://servicios1.afip.gov.ar/{name}/service.asmx?WSDL',
        },
    };

    constructor(private config: IConfigService) {}

    private async getTokens(service: WsServicesNames): Promise<ICredential> {
        const aliasedService = this.tokensAliasServices[service] || service;
        return this.retrieveTokens(aliasedService);
    }

    private async retrieveTokens(
        service: WsServicesNames
    ): Promise<ICredential> {
        const cacheTokens = await this.getTokensFromCache(service);
        if (cacheTokens) {
            debug(LOG.INFO, 'Read config from cache');
            return cacheTokens;
        }
        const fromNetwork = await this.getTokensFromNetwork(service);
        debug(LOG.DEBUG, 'Tokens from network:', fromNetwork);
        if (fromNetwork) {
            await this.saveCredentialsCache(service, fromNetwork);
        }
        return fromNetwork;
    }

    private async saveCredentialsCache(
        service: WsServicesNames,
        credential: ICredential
    ) {
        const cache: ICredentialsCache = await AfipSoap.getCredentialsCacheAll(
            this.config.cacheTokensPath
        );
        cache[service] = credential;
        debug(LOG.INFO, 'Write config to cache');
        await writeFile(this.config.cacheTokensPath, JSON.stringify(cache));
    }

    private static async getCredentialsCacheAll(
        path: string
    ): Promise<ICredentialsCache> {
        try {
            const raw = await readStringFromFile(path);
            return JSON.parse(raw) as ICredentialsCache;
        } catch (e: unknown) {
            if (this.isErrnoException(e) && e.code === 'ENOENT') {
                debug(LOG.WARN, 'Cache file does not exists.');
            } else {
                debug(LOG.ERROR, 'Fail to read cache file: ', e);
            }
            return {};
        }
    }

    private static isErrnoException(e: unknown): e is NodeJS.ErrnoException {
        return 'code' in (e as any);
    }

    private getLoginXml(service: string, networkTime: Date): string {
        const expire = moment(networkTime).add(
            this.config.tokensExpireInHours,
            'hours'
        );
        const formatDate = (date: Date | moment.Moment) =>
            moment(date).format().replace('-03:00', '');
        const xml = `
            <?xml version="1.0" encoding="UTF-8" ?>
            <loginTicketRequest version="1.0">
            <header>
            <uniqueId>${moment().format('X')}</uniqueId>
            <generationTime>${formatDate(networkTime)}</generationTime>
            <expirationTime>${formatDate(expire)}</expirationTime>
            </header>
            <service>${service}</service>
            </loginTicketRequest>
            `;
        return xml.trim();
    }

    private async signService(service: string): Promise<string> {
        const date = await AfipSoap.getNetworkHour();
        const [cert, privateKey] = await this.getKeys();
        return signMessage(this.getLoginXml(service, date), cert, privateKey);
    }

    private static async getNetworkHour(): Promise<Date> {
        const timeSync = NtpTimeSync.getInstance({
            servers: ['time.afip.gov.ar'],
        });
        const res = await timeSync.getTime();
        return res.now;
    }

    private async getKeys() {
        return [await this.getCert(), await this.getPrivateKey()];
    }

    private async getCert(): Promise<string> {
        if (this.config.certContents) {
            return this.config.certContents;
        }
        if (this.config.certPath) {
            return await readStringFromFile(this.config.certPath);
        }
        throw new Error('Not cert');
    }

    private async getPrivateKey(): Promise<string> {
        if (this.config.privateKeyContents) {
            return this.config.privateKeyContents;
        }
        if (this.config.privateKeyPath) {
            return await readStringFromFile(this.config.privateKeyPath);
        }
        throw new Error('Not private key');
    }


    private async uploadToS3(key: string, content: string): Promise<void> {
        const params = {
            Bucket: process.env.AWS_S3_BUCKET, // Asegúrate de configurar esta variable
            Key: key,
            Body: content,
            ContentType: 'application/xml', // Tipo de contenido
        };
    
        try {
            const command = new PutObjectCommand(params);
            await s3Client.send(command); // Usamos el s3Client global
            console.log(`Log subido a S3 exitosamente: ${key}`);
        } catch (err) {
            if (err instanceof Error) {
                console.error('Error al subir a S3:', err.message); // Solo si tiene `message`
            } else {
                console.error('Error desconocido al subir a S3:', err);
            }
            throw err; // Propaga el error
        }
    }

    

    private getSoapClient(serviceName: WsServicesNames) {
        const urls = this.urls[this.getAfipEnvironment()];
        const type = serviceName === 'login' ? 'login' : 'service';
        const url = urls[type].replace(
            '{name}',
            encodeURIComponent(serviceName)
        );
    
        return soap.createClientAsync(url, {
            namespaceArrayElements: false,
        }).then((client) => {
            // Capturar las solicitudes (request)
            client.on('request', async (xml: string) => {
                console.log('SOAP Request:', xml); // Muestra el XML
                try {
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    const key = `soap-logs/request_${serviceName}_${timestamp}.xml`;
                    await this.uploadToS3(key, xml); // Subir el request a S3
                } catch (err) {
                    if (err instanceof Error) {
                        console.error('Error al subir SOAP Request a S3:', err.message);
                    } else {
                        console.error('Error desconocido al subir SOAP Request a S3:', err);
                    }
                }
            });
            
            client.on('response', async (xml: string) => {
                console.log('SOAP Response:', xml); // Muestra el XML
                try {
                    const timestamp = new Date().toISOString().replace(/:/g, '-');
                    const key = `soap-logs/response_${serviceName}_${timestamp}.xml`;
                    await this.uploadToS3(key, xml); // Subir el response a S3
                } catch (err) {
                    if (err instanceof Error) {
                        console.error('Error al subir SOAP Response a S3:', err.message);
                    } else {
                        console.error('Error desconocido al subir SOAP Response a S3:', err);
                    }
                }
            });
    
            return client; // Es necesario para devolver el cliente modificado
        });
    }
    

    private getAfipEnvironment(): 'homo' | 'prod' {
        return this.config.homo ? 'homo' : 'prod';
    }

    private async getTokensFromNetwork(
        service: WsServicesNames
    ): Promise<ICredential> {
        const [signedData, client] = await Promise.all([
            this.signService(service),
            this.getSoapClient('login'),
        ]);
        debug(LOG.INFO, 'Asking tokens from network');
        const result: [any] = await client.loginCmsAsync({ in0: signedData });
        const loginCmsReturn: string = result[0].loginCmsReturn;
        const res = await parseXml<{
            loginTicketResponse: {
                credentials: {
                    token: string;
                    sign: string;
                };
            };
        }>(loginCmsReturn);
        return {
            created: moment().format(),
            service,
            tokens: res.loginTicketResponse.credentials,
        };
    }

    private isExpired(expireStr: string) {
        const now = moment(new Date());
        const expire = moment(expireStr);
        const duration = moment.duration(now.diff(expire));
        return duration.asHours() > this.config.tokensExpireInHours;
    }

    private async getTokensFromCache(
        service: WsServicesNames
    ): Promise<ICredential | null> {
        const cache = await AfipSoap.getCredentialsCacheAll(
            this.config.cacheTokensPath
        );
        const cacheService =
            typeof cache[service] === 'undefined' ? null : cache[service];

        if (cacheService && !this.isExpired(cacheService.created)) {
            return cacheService;
        }
        return null;
    }

    public async execMethod(
        service: WsServicesNames,
        method: string,
        params: any
    ) {
        debug(LOG.INFO, 'execMethod name', method);
        debug(LOG.INFO, 'execMethod params', params);
        const cred = await this.getTokens(service);
        debug(LOG.INFO, 'TOKENS', cred.tokens);

        const paramsWithAuth = {
            Auth: {
                ...params.Auth,
                Token: cred.tokens.token,
                Sign: cred.tokens.sign,
            },
            ...params.params,
        };
        debug(LOG.INFO, 'execMethod params with AUTH', params);
        const client = await this.getSoapClient(service);
        const call = client[method + 'Async'];
        const [result, rawResponse] = await call(paramsWithAuth);
        debug(LOG.DEBUG, 'execMethod rawResponse', rawResponse);
        const methodResponse = result[method + 'Result'];
        AfipSoap.throwOnError(methodResponse);
        return methodResponse;
    }

    private static throwOnError(response: any) {
        if (!response.Errors) {
            return;
        }
        if (!response.Errors.Err) {
            return;
        }
        const resErr = response.Errors.Err[0];
        const err: any = new Error(resErr.Msg);
        err.name = 'AfipResponseError';
        err.code = resErr.Code;
        throw err;
    }
}