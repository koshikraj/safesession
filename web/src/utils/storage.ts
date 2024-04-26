export const storeSessionKey = (key: string, privateKey: string) => {

    localStorage.setItem('sessionKey', JSON.stringify({key: key, privateKey: privateKey}));
}


export const loadSessionKey = (): any => {

    const sessionKey = localStorage.getItem('sessionKey');
    return sessionKey ? JSON.parse(sessionKey) : {};
}