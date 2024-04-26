import { Text, ActionIcon, Alert, Button, CopyButton, Input, Modal, Paper, Popover, rem, Tooltip, Skeleton } from '@mantine/core';
import classes from './account.module.css';
import { useEffect, useState } from 'react';
import useLinkStore from '@/store/link/link.store';
import { ethers, formatEther, parseEther, parseUnits, ZeroAddress } from 'ethers';

import { Icon2fa, IconCheck, IconChevronDown, IconClock, IconCoin, IconConfetti, IconCopy, IconDownload, IconEdit, IconError404, IconGif, IconGift, IconHomeDown, IconSend, IconTransferOut } from '@tabler/icons';
import { NetworkUtil } from '@/logic/networks';
import Confetti from 'react-confetti';
import { getIconForId, getTokenInfo, getTokenList, tokenList } from '@/logic/tokens';
import { send } from 'process';
import { getJsonRpcProvider } from '@/logic/web3';
import { loadSessionKey, storeSessionKey } from '@/utils/storage';
import { getSessionData, subscribeWithSessionKey, waitForExecution } from '@/logic/module';
import { IconAlertCircleFilled, IconCircleCheckFilled } from '@tabler/icons-react';
import { formatTime } from '@/logic/utils';
import { useDisclosure } from '@mantine/hooks';



export const AccountPage = () => {
  const { claimDetails, setClaimDetails, setConfirming, confirming} = useLinkStore((state: any) => state);
  
  const [opened, { open, close }] = useDisclosure(!Object.keys(loadSessionKey()).length);
  const [sendModal, setSendModal] = useState(false);
  const [tokenValue, setTokenValue] = useState<bigint>(0n);
  const [sendAddress, setSendAddress] = useState('0x958543756A4c7AC6fB361f0efBfeCD98E4D297Db');
  const [sendSuccess, setSendSuccess] = useState(false);
  const [sessionKeyActive, setSessionKeyActive] = useState(false);
  const [sessionKey, setSessionkey] = useState(loadSessionKey());
  const [privateKey, setPrivateKey] = useState('');
  const [limitAmount, setLimitAmount] = useState(''); 
  const [refreshIn, setRefreshIn] = useState<bigint>(0n);
  const [validTill, setValidTill] = useState(0);
  const [validAfter, setValidAfter] = useState(0);

  const [balanceLoading, setBalanceLoading] = useState(false);
  const [sendLoader, setSendLoader] = useState(false);
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [chainId, setChainId] = useState<string>('11155111');
  const [value, setValue] = useState<string>("0x0000000000000000000000000000000000000000");


  console.log(sessionKey)

  useEffect(() => {
    (async () => {

      const {validAfter, validUntil, limitAmount, limitUsed, lastUsed, refreshInterval} = await getSessionData(chainId, sessionKey.key, ZeroAddress);

      const currentTime = Date.now();
      const availableLimit =  currentTime > (parseInt(refreshInterval)*1000 + parseInt(lastUsed)*1000) && parseInt(refreshInterval) ? limitAmount : (limitAmount - limitUsed);

      setValidAfter(parseInt(validAfter));
      setValidTill(parseInt(validUntil));
      setRefreshIn(lastUsed + refreshInterval - BigInt(Math.floor(currentTime/ 1000)))
      setSessionKeyActive(currentTime < parseInt(validUntil)*1000 && currentTime > parseInt(validAfter)*1000);
      setLimitAmount(formatEther(limitAmount));
      setTokenValue(availableLimit)

      
    })();
  }, [chainId, sendLoader, confirming, sessionKey]);



  return (
    <>

 <Modal opened={opened} onClose={close} title="Import session key" centered>

<div className={classes.formContainer}>
      <div>
        <h1 className={classes.heading}>Add a session key</h1>
      </div>

      <div className={classes.inputContainer}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: '20px',
                  alignItems: 'center',
                }}
              >

              </div>

              <Input.Wrapper label={`Enter Session Private Key`}>   
              <Input
                  type="string"
                  size='lg'
                  value={privateKey}
                  onChange={(e: any) => setPrivateKey(e?.target?.value)}
                  placeholder="Enter the key"
                  className={classes.input}
                />
              </Input.Wrapper>

            </div>
            
              <Button
              size="lg" radius="md" 
              style={{marginBottom: '20px'}}
              fullWidth
              color="green"
              className={classes.btn}
              onClick={async () =>  {
                storeSessionKey((new ethers.Wallet(privateKey)).address, privateKey);
                setSessionkey({key: (new ethers.Wallet(privateKey)).address, privateKey: privateKey});
                close();
               
                
              } }
              loaderProps={{ color: 'white', type: 'dots', size: 'md' }}
              loading={sendLoader}
            >
              Load Now
            </Button>
            
    </div>
  
</Modal> 

<Modal opened={sendModal} onClose={()=>{ setSendModal(false); setSendSuccess(false); setValue(ZeroAddress);}} title="Claim your crypto" centered>

<div className={classes.formContainer}>
      <div>
        <h1 className={classes.heading}>Claim from Safe</h1>
      </div>
      <p className={classes.subHeading}>
        Just one click away!
      </p>



      <div className={classes.inputContainer}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  marginTop: '20px',
                  alignItems: 'center',
                }}
              >

            <Input.Wrapper label={`Enter Value (Available: ${formatEther(tokenValue)})`}>
                <Input
                  type="number"
                  size='lg'
                  // value={formatEther(tokenValue)}
                  defaultValue={formatEther(tokenValue)}
                  onChange={(e: any) => setTokenValue(parseEther(e?.target?.value))}
                  placeholder="Value"
                  className={classes.input}
                />

                </Input.Wrapper>
                


              </div>

              <Input.Wrapper label={`Enter Recipient Address`}>   
              <Input
                  type="string"
                  size='lg'
                  value={sendAddress}
                  onChange={(e: any) => setSendAddress(e?.target?.value)}
                  placeholder="Recipient Address"
                  className={classes.input}
                />
              </Input.Wrapper>

            </div>
            
              <Button
              size="lg" radius="md" 
              style={{marginBottom: '20px'}}
              fullWidth
              color="green"
              className={classes.btn}
              onClick={async () =>  {
                setSendLoader(true);
                const hash = await subscribeWithSessionKey(chainId, sendAddress, tokenValue);
                setSendLoader(false);
                setConfirming(true);
                setSendModal(false);
                await waitForExecution(hash);
                setConfirming(false);
               
                
              } }
              loaderProps={{ color: 'white', type: 'dots', size: 'md' }}
              loading={sendLoader}
            >
              Send Now
            </Button>


      { sendSuccess && <Alert variant="light" color="lime" radius="md" title="Transfer Successful" icon={<IconConfetti/>}>
      Your crypto assets have safely landed in the Success Galaxy. Buckle up for a stellar financial journey! 🚀💰
    </Alert>
      }
            
    </div>
  
</Modal>

    <Paper className={classes.accountContainer} shadow="md" withBorder radius="md" p="xl" >
      
      <div className={classes.formContainer}>
     { sessionKeyActive && 
     <Alert variant="light" color="green" radius="md" title="" icon={<IconCircleCheckFilled />}>
        <b>  The session key is valid till</b> <br/>
        {`${(new Date(validTill*1000).toDateString())} ${(new Date(validTill*1000).toLocaleTimeString())}`}
    </Alert> }
    { !sessionKeyActive && 
     <Alert variant="light" color="red" radius="md" title="" icon={<IconAlertCircleFilled/>}>
        <b>  The session key is either expired or not active yet </b>
    </Alert> }
        <div className={classes.avatarContainer}>
          <img
            className={classes.avatar}
            src="https://pbs.twimg.com/profile_images/1643941027898613760/gyhYEOCE_400x400.jpg"
            alt="avatar"
            height={100}
            width={100}
          />
          </div>


       <p className={classes.heading}>
       Session Key Details
      </p>

      { sessionKeyActive && <div>


        <p className={classes.balance}> { balanceLoading ? <Skeleton height={20} width={110} mt={6} radius="xl" /> : `${tokenValue ? formatEther(tokenValue) : limitAmount } ${getTokenInfo(parseInt(chainId), ZeroAddress).label}` }</p> 
          
        {  Boolean(tokenValue) && <div className={classes.balanceContainer}>
                      <Text >  Available to claim
                      </Text>
                      <IconCircleCheckFilled style={{ width: rem(30), color: 'green'}} />
          </div>
        }

      {  !tokenValue && refreshIn > 0n && <div className={classes.balanceContainer}>
                      <Text > 
                      </Text>
                      <Alert variant="light" color="lime" radius="md" title=" Available to claim in" icon={<IconClock/>}>
                     {formatTime(Number(refreshIn))} 💰
                      </Alert>
   
          </div>
     }

          
        <div className={classes.actionsContainer}>

      
          <div className={classes.actions}>

          {  Boolean(tokenValue) &&
            <Button size="lg" radius="md"
             style={{ width: '220px' }}
            className={classes.btn} 
            color="teal" 
            onClick={()=> setSendModal(true)}>
              Claim
            </Button>
          }


        {  ! tokenValue &&
             <Button size="lg" radius="md"
                color={ "#49494f" }
                disabled
                variant={ "filled" } 
                style={{ width: '220px' }}>Claim
                </Button>
          }
          </div>

          <div className={classes.balanceContainer}>
         <Text >  <p > Update Session Key</p>
          </Text>
  
                {/* <Tooltip label={copied ? 'Copied' : 'Copy'} withArrow position="right"> */}
                  <ActionIcon color={'gray'} variant="subtle" onClick={open}>
                
                      <IconEdit style={{ width: rem(16) }} />
             
                  </ActionIcon>
                {/* </Tooltip> */}

            </div>
          
        </div>
        </div> }

        </div>

    </Paper>
    {  Boolean(claimDetails.amount) && <Confetti width={dimensions.width} height={dimensions.height} /> }
    </>
  );
};
