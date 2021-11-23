const { usleep } = require('rpio');
console.log("Running with module as:",module)
var rpio = require('rpio');

var maxSteps = 2 ** 15;
var minSteps = - (2 ** 15);
var auto_home_max = (10*175542 ) /* HACK - use hard-coded inches for now*/
/**
 * The script is about to exit - whether by design or abnormal termination.
 * Handle a gracefull shutdown of the ASIC and the SPI interface.
 */
function clean_exit() {
    // We're about to terminate. Unless this is overridden, also 
    //  - disable the motor driver, 
//    rpio.write(7,rpio.HIGH); // Disable dirver on TMC5130 BOB DRV_ENN pin 9
    //  - and shut off the chip VCC_IO
//    rpio.write(3,rpio.LOW);
    console.log("Exiting motor.js");
    rpio.exit();
}

/**
 * Rudimentary error handling when running in a console. This attempts to catch various
 * signals and interrupts and performs an orderly shutdown of the ASIC.
 */
function setup_shutdown() {
    process.once('SIGINT', function () {
        clean_exit();
        console.log("Interrupted - ");
        process.exit(0);
    });
    process.once('SIGHUP', function () {
        clean_exit();
        console.log("Hangup - ");
        process.exit(0);
    });
    process.once('SIGTERM', function () {
        clean_exit();
        console.log("Terminated - ");
        process.exit(0)
        ;
    });
}

rpio.init({gpiomem:false, mapping: 'physical', close_on_exit: false });
// Nail some settings that might change depending on what is opened first, and to provide my own termination handling

//const TMC_VIO_PIN = 3;
const TMC_VIO_PIN = 37;
const TMC_VIO_PINproto = 32;     // Proto boards dont have 37 wired (GPIO 26), so use GPIO12
const TMC_ENA_PIN = 33;
rpio.open(TMC_VIO_PIN,rpio.OUTPUT,rpio.LOW); // This powers down the TMC5130 BOB VIO line
rpio.open(TMC_VIO_PINproto,rpio.OUTPUT,rpio.LOW); // This powers down the TMC5130 BOB VIO line
usleep(500);  // Reset the chip, in case.
// N/A If not a BOB from Trinamic  //rpio.open(5,rpio.OUTPUT,rpio.LOW);  // Configure Internal Clock on TMC5130 BOB CLK16 pin 8
rpio.open(TMC_ENA_PIN ,rpio.OUTPUT,rpio.LOW); // Disable dirver on TMC5130 BOB DRV_ENN pin 9
rpio.open(TMC_VIO_PIN,rpio.OUTPUT,rpio.HIGH); // This powers UP the TMC5130 BOB VIO line
rpio.open(TMC_VIO_PINproto,rpio.OUTPUT,rpio.HIGH); // This powers UP the TMC5130 BOB VIO line


rpio.auxSpiBegin();  
//rpio.auxSpiChipSelect(0); // Select Pin 24 SPIO_CS0
//rpio.auxSpiSetCSPolarity(0,rpio.LOW);  // Select CS polarity - 0 is active Low
rpio.auxSpiSetClockDivider(512);   // 128 gets us around 3.125 MHz SPI clock, 256 would get 1.56 MHz
// But slower seems to be needed on a standard Pi 3b wired to the TMC5130 - BOB
//rpio.auxSpiSetDataMode(3);

/**
 * Read a register from the ASIC.
 * @param {number} reg      The register number to read.
 * @param {boolean} pipe    if true, assumes a pipe-lined sequence of register reads is happening,
 * and the double read that normally has to happen to get a register value is not done. 
 * In this mode, the value returned is the **LAST register red's*** value.
 * @returns {object {number} status, {number} value}}  
 *  status is the immediate SPI return status - a few bits of critical ASIC state.
 *  value is the value of the register requested. ***but see pipe for caution***
 */
function tmc5130_readreg(reg, pipe=0) {
    var txbuf = Buffer.from([reg, 0x00, 0x00, 0x00, 0x00]);
    var rxbuf = Buffer.alloc(txbuf.length);
    rpio.auxSpiTransfer(txbuf, rxbuf, txbuf.length);
    // Read it again = the first transaction merely told the chip we are accessing the register.
    if(pipe==0) {
        rpio.auxSpiTransfer(txbuf, rxbuf, txbuf.length);  // which we now have. 
        // NOTE - it is possible to pipeline this 
        // if pipe is set, it is assumed a previous read or write initated the setup, 
        // and we only need to get the result. Note that the reg asked for is NOT the one returned, in that case.
    }   
    return {
        status: rxbuf[0],
        value:  rxbuf[1]<<24 |  rxbuf[2] << 16 | rxbuf[3] << 8 | rxbuf[4] 
    }
}
/**
 * Write a value to a register in the ASIC.
 * @param {number} reg      The number of the register to write.
 * @param {number} value    The value to be transferred to the ASIC targetting the register *reg*
 * @returns {object {number} status, {number} value}}  
 *  status is the immediate SPI return status - a few bits of critical ASIC state.
 *  value is the value of the rest of the returned SPI packet. It may be the result of a previous read,
 *  or other spurious data, depending on the state of the ASIC. IT IS NOT the old content value of 
 *  the register being targeted, nor the new value being set.
 */
function tmc5130_writereg(reg,value) {
    var txbuf = Buffer.from([reg| 0x80,  0xFF & (value>>24), 0xFF & (value>>16), 0xFF & (value>>8), 0xFF & (value) ] );
    var rxbuf = Buffer.alloc(txbuf.length);
    rpio.auxSpiTransfer(txbuf, rxbuf, txbuf.length);
    return {
        status: rxbuf[0],
        value:  rxbuf[1]<<24 |  rxbuf[2] << 16 | rxbuf[3] << 8 | rxbuf[4]
    }
}
// These are TMC register names and their addresses.
const rTMC_GConf     = 0x00; // RW 17 bits - various flags and diagnostic control.
const rTMC_GStat     = 0x01; // R+WC 3 bits Global Status flags.
const rTMC_IOIn      = 0x04; // RO  8+8 bits, lower byte is i/o pins state, and upper byte is ASIC version.
const rTMC_IHoldIRun = 0x10; // W   5/5/4 14 bits, 3 fields. Each byte is a value.
// IHold 0..4 Standstill current
// IRun  8..12  Run current in 32nd increments - not an absolute
// IHoldDelay 16..19 Delay before powerdown.
const rTMC_TPowerDown = 0x11; // W   8 bits, Delay after standstill
const rTMC_TStep      = 0x12; // R  20 bits, Actual measured time between two 1/256 microsteps in units of 1/fCLK
const rTMC_TPWMThrs   = 0x13; // W  20 bits. This is the upper velocity for StealthChop voltage PWM mode. TSTEP >= TPWMThrs - StealthChop PWM mode enabled, DCStep is disabled.
const rTMC_TCoolThrs  = 0x14; // W  20 bits. This is the lower threshold velocity for switching on smart energy CoolStep and StallGuard.
const rTMC_THigh      = 0x15; // W  20 bits. This velocity setting allows velocity dependent switching into a different chopper mode and fullstepping to maximize torque.

const rTMC_RampMode  = 0x20; // RW, 2 bits
const rTMC_XActual   = 0x21; // RW 32 bits. signed.  Actual motor position
// for velocity, units are in microsteps/sec. Note that microsteps can shange, default is 256 uSteps in a step. 
// for accelerations, in uSteps/s^2
const rTMC_VActual   = 0x22; // RO 24 bits. signed. velocity in usteps/s, negative sign indicate motion towrds a lower XActual
const rTMC_VStart    = 0x23; // W  18 bits. unsigned. Motor Start Velocity
const rTMC_A1        = 0x24; // W  16 bits. unsigned. first acceleration between VSTART and V1 
const rTMC_V1        = 0x25; // W  20 bits. unsigned. Threshold after which AMAX is used to get to VMAX
const rTMC_AMax      = 0x26; // W  16 bits. unsigned. Acceleration when velocity is above V1 to get to VMAX
const rTMC_VMax      = 0x27; // W  23 bits. unsigned. Maximum velocity the motor will strive for. May be less if loads prevent reaching this. 
const rTMC_DMax      = 0x28; // W  16 bits. unsigned. Deceleration when velocity is above V1 to slow to V1
const rTMC_D1        = 0x2A; // W  16 bits. unsigned. Deceleration when velocity is below V1 to slow to VSTOP
const rTMC_VStop     = 0x2B; // W  18 bits. unsigned. Motor Stop velocity. Set VSTOP >= VSTART to jog small amounts. NOT 0, 10 recommended.
const rTMC_TZeroWait = 0x2C; // W  16 bits. unsigned. Pause at zero before next motion can start. In t-clks/512
const rTMC_XTarget   = 0x2D; // RW 32 bits. signed. Target postion when in RAMPMODE = 0

// RAMP Generator Control Registers
const rTMC_VDCMin    = 0x33; // W  23 bits. unsigned. DcStep control, use for stall detection/prevention
const rTMC_SW_Mode   = 0x34; // RW 11 bits. See TMC_SW_Mode_{flags} for details
const rTMC_RampStat  = 0x35; // R+C 14 bits. See TMC_RampStat_{flags} for details

// These are TMC defualt values, or constants, used to get a motor minimally running. Safe for initial uses.
const cTMC_IHold     = 0x0a;  // IHold holding current for motor at standstill.
const cTMC_IRun      = 0x10;  // IRun max current driving the motor when running.
const cTMC_HoldDelay = 0x06;  // IHoldDelay delay to go from stopped motor being held with current to no drive to motor.

// These are values read from the TMC that don't change after power-on, or dont change much. So keep a copy, rather than read it each time
const cTMC_5160_ID = { val : 0x30, name : "TMC5160"  }; // throw other chip specific variant stuff in here
const cTMC_5130_ID = { val : 0x11, name : "TMC5130A" };
const cTMC_Unknown_ID = { val : 0, name : "Unknown" };
var vTMC_Version = cTMC_Unknown_ID;   // Two versions are known at this time:  0x11 = TMC5130A, and 0x30 = TMC5160

const rTMC_ChopConf  = 0x6C; // RW 32 bits. Chopper and driver configuration
const rTMC_CoolConf  = 0x6D; // RW 32 bits. CoolStep smart current and StallGuard2 configuration
const rTMC_DCCtrl    = 0x6E; // W  9..0 DC_Time 23..16 DC_SG DC Step and StallGuard configuration
const rTMC_DrvStatus = 0x6F; // R  StallGuard2 value and driver error flags.
const rTMC_PWMConf   = 0x70; // W 32 bits. See TMC_PWMConf_{flags} for details

// Shadow registers - named after the register they shadow, as some registers of interest are write only
var sTMC_VMax = 10000; // 
var sTMC_IMax = 16;     // Gets reset to value in the HTML file, but until then, this is medium good.
var sTMC_AMax;          // Shadow register of the Acceleration
var sTMC_DMax;          // Shadow register of the Decceleration
var sTMC_V1;          // Shadow register of the First Velocity Threshold
var sTMC_D1;          // Shadow register of the Decceleration
var nTMC_VMax = sTMC_VMax;  // nominal value - not exactly the shadow value, but it is the normal operating value we may want to revert to.
var nTMC_AMax;          // Nominal value of the Acceleration
var nTMC_DMax;          // Nominal value of the Decceleration


function TMC_Configure() {

    // Read GSTAT to clear reset flag
    res = tmc5130_readreg(rTMC_GStat,1);

    res = tmc5130_readreg(rTMC_IOIn,1);
    console.log("TMC5130 Global Status", res.status, res.value.toString(16))

    res = tmc5130_readreg(rTMC_DrvStatus,1);  // Don't forget - getting a read value is one read out of sync...
    console.log("TMC5130 status and version:", res.status, res.value.toString(16))

    {   // Detirmine the flavour of the ASIC we are speaking to. A few places this makes a difference.
        vTMC_Version = cTMC_5160_ID.val == (res.value >> 24) ? cTMC_5160_ID :
            (cTMC_5130_ID.val == (res.value >> 24) ? cTMC_5130_ID : cTMC_Unknown_ID);
    }
    console.log("TMC5130 version : ", vTMC_Version)


    res = tmc5130_readreg(rTMC_RampStat,1);
    console.log("TMC5130 Drv_Status:", res.status, res.value.toString(16))

    res = tmc5130_writereg(rTMC_ChopConf,0x000100c3);  // CHOPCONF  Nibble 6 is # microsteps 0 =256, 1 =128, etc.
    // The write also return the read from the previous command.
    console.log("TMC5130 RAMP_Status:", res.status, res.value.toString(16))
    
    // Write IRUN IHOLD
    res = tmc5130_writereg(rTMC_IHoldIRun, cTMC_IHold | cTMC_IRun<<8 | cTMC_HoldDelay <<16 );
    res = tmc5130_writereg(rTMC_TPowerDown,0x0a);     // TPOWERDOWN= 10
    res = tmc5130_writereg(rTMC_GConf,4);    // 4 = EN_PWM_MODE
    res = tmc5130_writereg(rTMC_TPWMThrs ,500);   // TPWM_THRS 500

    if (vTMC_Version == cTMC_5130_ID) {
        console.log("Detected 5130 - setting PWMConf for onboard MOSFETs.")
        res = tmc5130_writereg(rTMC_PWMConf,0x401c8);  // Only for 5130
    }

    console.log("Reply of TMC5130:", res.status, res.value)


    res = tmc5130_writereg(rTMC_A1,0x3e8);    // A1
    res = tmc5130_writereg(rTMC_V1,0xc350);    // v1
    res = tmc5130_writereg(rTMC_AMax,sTMC_AMax = 0x1f4);    // AMax
    res = tmc5130_writereg(rTMC_VMax,0x40d04);    // VMax
    res = tmc5130_writereg(rTMC_DMax,0x2bc);    // DMax
    res = tmc5130_writereg(rTMC_D1,0x578);    // D1
    res = tmc5130_writereg(rTMC_VStop,0x10);    // vstop
    res = tmc5130_writereg(rTMC_RampMode,0x0);    // RAMPMODE = 0 Wherever we are, it is position 0
}

TMC_Configure();

/* At this time, chip is at logical postion 0, and we don't know where we actually are in the world.
  So until we are homed, use low power and low speed settings.
*/
var sTMC_VMax_failsafe = 200000;  //Some arbitrary low ball hopefully intrinsically safe values
var sTMC_iMax_failsafe = 3;
var sTMC_DMax_failsafe = 65535;   // Decellerate at steepest possible rate.
var sTMC_AMax_failsafe = 100;   // But accellerate at a sedate rate
var sTMC_AMax_autohome = 1000;

function setSettings(sliders) {
    // all the hidden inputs in this collection need to be applied to the corresponding registers 
    sliders.forEach( field => {
        const fld = field.querySelector("[type=hidden]")
        switch (fld.id) {
            case "max-velocity": 
                console.log("Changing ",fld.id, " to ", fld.value * 1000, " register ", rTMC_VMax )
                reg = tmc5130_readreg(rTMC_RampMode);
                if (reg.value == 0) { // if we are in ramp mode, can change max-velocity with impunity
                    tmc5130_writereg(rTMC_VMax, nTMC_VMax = sTMC_VMax = fld.value * 1000)
                } else {  // but ibn the other modes, it is the speed we are targeting to turn at.
                    nTMC_VMax = sTMC_VMax = fld.value * 1000; 
                }
                break;
            case "init-velocity":
                console.log("Changing ",fld.id, " to ", fld.value * 1000, " register ", rTMC_V1 )
                tmc5130_writereg(rTMC_V1, sTMC_V1 = fld.value * 1000)
                break;
            case "max-acceleration":
                console.log("Changing ",fld.id, " to ", fld.value * 10, " register ", rTMC_AMax )
                tmc5130_writereg(rTMC_AMax, nTMC_AMax = sTMC_AMax = fld.value * 10)
                break;
            case "max-deceleration":
                console.log("Changing ",fld.id, " to ", fld.value * 10, " register ", rTMC_DMax )
                tmc5130_writereg(rTMC_DMax,  nTMC_DMax = sTMC_DMax = fld.value * 10)
                break;
            case "init-acceleration":
                console.log("Changing ",fld.id, " to ", fld.value * 10, " register ", rTMC_A1 )
                tmc5130_writereg(rTMC_A1,  sTMC_A1 = fld.value * 10)
                break;
            case "term-deceleration":
                console.log("Changing ",fld.id, " to ", fld.value * 10, " register ", rTMC_D1 )
                tmc5130_writereg(rTMC_D1,  sTMC_D1 = fld.value * 10)
                break;
            case "current-limit": {
                sTMC_IMax = fld.value;
                var adj_val = cTMC_IHold | sTMC_IMax<<8 | cTMC_HoldDelay <<16 ;
                console.log("Changing ",fld.id, " to ", adj_val.toString(16), " register ", rTMC_IHoldIRun )
                tmc5130_writereg(rTMC_IHoldIRun, adj_val );
                break;
            }
            // Now the tunings panel.
            case "tmc_tpowerdown":
                console.log("Changing ",fld.id, " to ", fld.value, " register ", rTMC_TPowerDown )
                tmc5130_writereg(rTMC_TPowerDown, fld.value)
                break;
            case "tmc_tpwmthrs":
                console.log("Changing ",fld.id, " to ", fld.value, " register ", rTMC_TPWMThrs )
                tmc5130_writereg(rTMC_TPWMThrs, fld.value)
                break;
            case "tmc_tcoolthrs":
                console.log("Changing ",fld.id, " to ", fld.value, " register ", rTMC_TCoolThrs )
                tmc5130_writereg(rTMC_TCoolThrs, fld.value)
                break;
            case "tmc_thigh":
                    console.log("Changing ",fld.id, " to ", fld.value, " register ", rTMC_THigh )
                    tmc5130_writereg(rTMC_THigh, fld.value)
                    break;
        }
      });
  
}
function restoreSettings(failsafe) {
    // only if invoked as restoreSettings("Normal") do the normal operating paramters get applied. All others go to failsafe mode.
    if (failsafe=="Normal") {
    // restore the previous apllied settings.
                reg = tmc5130_writereg(rTMC_RampMode,0);
                tmc5130_writereg(rTMC_VMax, sTMC_VMax = nTMC_VMax)
                console.log("Changing VMax to ", nTMC_VMax)
                 tmc5130_writereg(rTMC_V1, sTMC_V1 )
                tmc5130_writereg(rTMC_AMax, sTMC_AMax = nTMC_AMax )
                tmc5130_writereg(rTMC_DMax,  sTMC_DMax = nTMC_DMax)
                tmc5130_writereg(rTMC_A1,  sTMC_A1)
                tmc5130_writereg(rTMC_D1,  sTMC_D1 )
                var adj_val = cTMC_IHold | sTMC_IMax<<8 | cTMC_HoldDelay <<16 ;
                tmc5130_writereg(rTMC_IHoldIRun, adj_val );
                failSafeMode = false;
                console.log(`FAILSAFE mode disengaged - limits ${maxSteps} and ${minSteps} enforced`)
        }

        else failsafeSettings()
    }


function stallGuard( enable=false, { sgt = 6, tcoolthrs = 100}={})
{
    /*
    Turn on stallGuard - monitor the load on the motor and STOP if load approches overload. 
    It requires running above tcoolthrs, and sgt needs to be emperically tuned.
    */


}

function failsafeSettings(){
    /* Apply / override some values to be much lower than normal operating conditions
     to prevent bad things happening if we don't know where we are.
        sTMC_VMax_failsafe
        sTMC_iMax_failsafe 
    */
     // "max-velocity":
        console.log("failsafe Changing max-velocity to ", sTMC_VMax_failsafe, " register ", rTMC_VMax )
        reg = tmc5130_readreg(rTMC_RampMode);
        if (reg.value == 0) { // if we are in ramp mode, can change max-velocity with impunity
            tmc5130_writereg(rTMC_VMax, sTMC_VMax = sTMC_VMax_failsafe)
        } else {  // but in the other modes, it is the speed we are targeting to turn at.
            sTMC_VMax = sTMC_VMax_failsafe;
        }

        // Set special settings for max accelleration which applies in this mode
        // "max-acceleration":
            console.log("Changing TMC_AMax to ", sTMC_AMax_failsafe * 10, " register ", rTMC_AMax )
            tmc5130_writereg(rTMC_AMax, sTMC_AMax = sTMC_AMax_failsafe * 10);
        //  "max-deceleration"
            console.log("Changing TMS_DMax to ", sTMC_DMax_failsafe * 10, " register ", rTMC_DMax  )
            tmc5130_writereg(rTMC_DMax,  sTMC_DMax = sTMC_DMax_failsafe * 10)


        //"current-limit": 
            var adj_val = cTMC_IHold | sTMC_iMax_failsafe<<8 | cTMC_HoldDelay <<16 ;
            console.log("failsafe Changing current-limit to ", adj_val.toString(16), " register ", rTMC_IHoldIRun )
            tmc5130_writereg(rTMC_IHoldIRun, adj_val );
            failSafeMode = true;
            console.log(`FAILSAFE mode enabled - limits ${maxSteps} and ${minSteps} ignored`)
}

function homeSetZero(){
    /* Assume current position is Zero, and apply normal operating speeds/power
        Particualrly, change Actual Pos to 0, set VMax and iMax to desired value
    */

       // Reset the Chip 
       rpio.open(TMC_VIO_PINproto,rpio.OUTPUT,rpio.LOW); // This powers down the TMC5130 BOB VIO line
       rpio.open(TMC_VIO_PIN,rpio.OUTPUT,rpio.LOW); // This powers down the TMC5130 BOB VIO line
        usleep(500);  // Reset the chip, in case.
        // N/A If not a BOB from Trinamic  //rpio.open(5,rpio.OUTPUT,rpio.LOW);  // Configure Internal Clock on TMC5130 BOB CLK16 pin 8
        rpio.open(TMC_ENA_PIN ,rpio.OUTPUT,rpio.LOW); // Disable dirver on TMC5130 BOB DRV_ENN pin 9
        rpio.open(TMC_VIO_PIN,rpio.OUTPUT,rpio.HIGH); // This powers UP the TMC5130 BOB VIO line
        rpio.open(TMC_VIO_PINproto,rpio.OUTPUT,rpio.HIGH); // This powers UP the TMC5130 BOB VIO line
 
        TMC_Configure();
        failSafeMode = false;
        restoreSettings("Normal")
        console.log(`FAILSAFE mode disengaged - limits ${maxSteps} and ${minSteps} enforced`)
 }
function postionAcquired(res) { // The status bits in the latest read inform if we acquired the target. 
    return (res.status & 0x20)
}

function getPostion() {
    // For now, simply tracks the position and when the motion controller is happy it arrived, report true.
    // Might want to enhance this with stall detection and prevention.
    res = tmc5130_readreg(rTMC_XActual);    // Query XACTUAL, but only care for the status flag 'acquired'
    // console.log("Position Poll: Reply of TMC5130:", res.status, res.value)
    return (res)
}

   /**
    * mvve to a position specified in microsteps. 
    * 
    * @param {number} position  signed integer, the number of microsteps to move.
    * @param {function} updates if provided, is called everytime there is a position update with the current position
    * @return {Promise}         Return a Promise, which allows for use of the '.then' syntax
    * 
    * It is possible to specify a reject function in case there is an error or invalid 
    * position request, but this is not implemented yet.
    * 
    * Sample use:
~~~~
       moveTo( 25600 ).then(function(res) {
            console.log('moved half a turn!')
       }
       console.log('Motor commanded to move 1/2 turn');
~~~~
    * 
    * NOTE - the call-back is called after the motor has reached the specified position.
    *  It asynchrounously moves there, and the statement AFTER the moveTo is immediately
    *  executed, possibly even before the motor starts moving. Though the inital command
    *  to move the motor will have been issued.
    * 
    * Dependencies: 
    * The number of microsteps are by default 512 microsteps per step. This can be changed 
    * in the ASIC so while 512 might move 1 step, there is no checking to enforce this.
    * The acceleration, decelleration, maximum velocities and stop speeds are set in the ASIC
    * and the last values are used.
    */
function moveTo(position, updates) {
    var m_res = getPostion();
    if (!failSafeMode ) { // If not in failSafeMode, ie if not in low power mode, then check travel limits
        if( Number(position) > Number(maxSteps) )
        { // Target is past top end, 
            if  ( Number(m_res.value) > Number(maxSteps)  )
            { // and current position is outside limits.
                if ( Number(position) > Number(m_res.value))
                {  // if request is away from limit dissallow it
                    console.log(`MOTOR: Position Above Travel limit ${position} beyond ${maxSteps} NO MOTION`)
                    position = m_res.value; // so force NO MOTION
                }
            } 
            else
            { // Not above limit, but asking to move past, so set move to the limit.
                console.log(`MOTOR: Travel limit imposed ${position} beyond ${maxSteps}`)
                position = maxSteps; position++; // assigning maxSteps+1 does a string concatination !? this forces number.
            }
        }
        else if (Number(position) < Number(minSteps) )
        {  // Target below lower end
            if  ( Number(m_res.value) < Number(minSteps)  )
            { // and current position is outside limits.
                if (Number(position) < Number(m_res.value))
                {  //  and target is below current position, so not a move in right direction
                    console.log(`MOTOR: Position Above Travel limit ${position} beyond ${maxSteps} NO MOTION`)
                    position = m_res.value; // so force NO MOTION
                }
            }
            else 
            {  // not below limit, but moving past limit, so set move to stop at limit
                    console.log(`MOTOR: Travel limit imposed ${position} before ${minSteps}`)
                    position = minSteps;  position--; // assigning minSteps-1 does a string concatination. using -- forces number.
            }
        }
    }
    var poll_backoff = 100 // start with this intervall, but bump it if we're not getting 
    var polls = 0;
    var update_response;
    m_res = tmc5130_writereg(rTMC_RampMode,0x0);    // RAMPMODE, so XTarget != XActual causes us to move there.
    return new Promise(function(acquired, stalled) {
        // Do the stuff to start moving towards position
        cmd = tmc5130_writereg(rTMC_XTarget,position);    // move to new postion
        console.log("Starting MOVE to ", position, " : Reply of TMC5130:", cmd.status, cmd.value)
        emergency_stop = false;
        if (cmd.status != 0 | cmd.value != 0) {
            setTimeout(function poll(){
                polls ++;
                m_res = getPostion();
                if ( typeof(updates)=='function')  update_response = updates(m_res.value);
                if (postionAcquired(m_res))
                    if ( m_res.value == position) { // May need to add a fudge factor, we'll have to see
                        acquired(m_res.value);  // return the current position, and break out of the polling loop
                    }
                    else {
                        stalled(m_res.value)  // If the driver stopped with a position other than the one we askled for, something odd happened.
                    }    
                else 
                    setTimeout(poll, poll_backoff ); // = poll_backoff + 100); // If we're not there yet, poll again
            },poll_backoff) ;       // Now poll the position reports untill we get there
            // For now, we only succeed - there are no timeouts if we dont get there,
            // or we have a stall
        } 
        else // if there is no TMC5130 to talk to, don't wait around to get anywhere
        {
            setTimeout(function poll(){
                here = polls++ * (position/4)
                if ( typeof(updates)=='function')  updates(here);  // report we've reached the target position
                // as we're faking it, poll 4 tinmes before we pretend we got someplace
                if (emergency_stop ) stalled(here)
                if (polls > 4) acquired(here);  // This breaks out of the polling loop
                else 
                    setTimeout(poll, poll_backoff*4 ); // = poll_backoff + 100); // If we're not there yet, poll again
            },poll_backoff * 4 ) ;       // Wait 1.6 seconds when faking.
        }
    })
}

function energize( powerOn ) 
{
    rpio.open ( TMC_ENA_PIN ,rpio.OUTPUT, powerOn ? rpio.LOW : rpio.HIGH );
}
function setLimits(min,max, ah=100)
{
    minSteps = Number(min);
    maxSteps = Number(max);
    auto_home_max = Number(ah);
}
exports.moveTo = moveTo;
exports.clean_exit = clean_exit;
exports.setSettings = setSettings;
exports.failsafeSettings = failsafeSettings;
exports.homeSetZero = homeSetZero;
exports.energize = energize;
exports.maxSteps  = maxSteps;
exports.minSteps = minSteps;
exports.setLimits = setLimits;
exports.vTMC_Version = vTMC_Version;

// SIMPLY ROTATE
function speedAcquired(target_vel) {
    // For now, simply tracks the speed and when the motion controller is happy it arrived, report true.
    // Might want to enhance this with stall detection and prevention.
    // NOTE: If we're looking for speed 0, we look at the standstill flag, not the velocity reached flag
    var p_res = tmc5130_readreg(rTMC_VActual);    // Query VACTUAL, but only care for the status flag 'acquired'
    // console.log("Speed: Reply of TMC5130:", res.status, res.value)
    return (p_res.status & (target_vel? 0x10 : 0x08));  // Distinguish flags for moving at desired speed, or at standstill
}
   /**
    * Turn with speed left or right.
    * 
    * @param {number} velocity  signed integer, the speed to turn at. positive is one way, negative the other
    * @param {function} updates function that is called with the current position (in motor micro-steps) every time the driver is polled.
    * @return {Promise}         Return a Promise, which allows for use of the '.then' syntax
    * 
    * It is possible to specify a reject function in case there is an error or invalid 
    * position request, but this is not implemented yet.
    * 
    * Sample use:
~~~~
       turnAt( 25600 ).then(function(res) {
            console.log('turning at 25600 steps/second')
       }
       console.log('Motor commanded to turn at 25600 micro-steps/second');
~~~~
    * 
    * NOTE - the promise completes after the motor has returned to full stop.
    *  It attempts to reach that speed given, and the statement AFTER the turnAt is immediately
    *  executed, possibly even before the motor starts moving. Though the inital command
    *  to move the motor will have been issued.
    * It is up to an asynchrounous, external function to issue another command to the motor
    * to cause it to change speed, or stop. This function will execute until the speed is 0, again.
    * 
    * Dependencies: 
    * The number of microsteps are by default 512 microsteps per step. This can be changed 
    * in the ASIC so while 512 might move 1 step, there is no checking to enforce this.
    * The acceleration, decelleration, maximum velocities and stop speeds are set in the ASIC
    * and the last values are used.
    */
function turnAt(velocity, updates) {
    var poll_backoff = 100 // start with this intervall, but bump it if we're not getting 
    var t_res = tmc5130_writereg(rTMC_RampMode,( velocity>=0 )? 1 : 2  );    // VELMODE, so pos or neg turning
    var update_response = 0;
    return new Promise(function(acquired, stalled) {
        // Do the stuff to start moving towards speed
        	// Set absolute desired velocity
	    cmd = tmc5130_writereg(rTMC_VMax, Math.abs(velocity));

        console.log("Starting TURN at ", velocity, " : Reply of TMC5130:", cmd.status, cmd.value)
        if (cmd.status != 0 | cmd.value != 0) {
            if (cmd.status  & (velocity ? 0x10 : 0x08))  { 
                acquired('Speed already obtined!') 
            } else {
                setTimeout(function poll(){
                    t_res = getPostion();
                    if ( typeof(updates)=='function')  update_response = updates(t_res.value);
                    if ( update_response == 0 ) {
                        if (speedAcquired( 0 )) // NOTE : we only successully terminate a Turn command when we stop, ie return to velocity 0
                        acquired(t_res.value);  // report new position, and break out of the polling loop
                        else 
                            setTimeout(poll, poll_backoff ); // If we're not at speed, poll again   
                    }
                    else {
                        console.log("Motor.turnAt stalled with :", update_response)
                        stalled(update_response)
                    }
                },poll_backoff) ;       // Now poll the position reports untill we get there
                // For now, we only succeed - there are no timeouts if we dont get there,
                // or we have a stall
            }
        }
        else // if there is no TMC5130 to talk to, don't wait around to get anywhere
        {
            setTimeout(function poll(){
                acquired('Turning faked');  // This breaks out of the polling loop
            },poll_backoff * 15 ) ;       // Wait 1.5 seconds when faking.
        }    
        })
}
var emergency_stop = false;

function fullStop(emergency) {
    var f_res=0;
    if (emergency) {
        // temporarily override AMax to max and shut it down
        f_res = tmc5130_writereg(rTMC_AMax,sTMC_DMax_failsafe);  // Theoretical max it can Accelerate/decellerate
        emergency_stop = true;
    }
    return turnAt(0).then( function (report) {
        // OK, we got to 0, revert back to normal ramp mode operation.
        console.log("fullStop - complete with:",report);
        f_res = tmc5130_readreg(rTMC_XActual);  // OK, we've stopped, BUT - where we are is now where we wanted to be.
        f_res = tmc5130_writereg(rTMC_XTarget,res.value)  // So update that. Then revert to position movement mode.
        f_res = tmc5130_writereg(rTMC_RampMode,0x0);    // RAMPMODE, so XTarget != XActual causes us to move there.
        f_res = tmc5130_writereg(rTMC_AMax,sTMC_AMax);  // Back to previous setting
        f_res = tmc5130_writereg(rTMC_VMax, sTMC_VMax);   // revert velocity to last known setting
    })
}
exports.turnAt = turnAt;
exports.fullStop = fullStop;
exports.autoHome = autoHome;

function autoHome( drive_ratio = 256*200 , updates)  // assume a working ratio is 1 rotation per inch.
{   
    /*
    Assume we are far enough away from the left stop!
    Phase one - start a low power, moderte motion towards the left, using motion controller.
    Wait for velocity_reached.
    Phase two - turn on StallGuard (sg_stop in SW_MODE) and set TCOOLTHRS to TSTEP. Then 
    increase velocity a bit, and wait for velocity = 0 or/and stallgaurd active.
    Phase 3 - we are at zero. 
    */
   var starting_pos = 0;
   var ah_phase = 0, ah_next = 0;
   const max_travel = 1.01 *  auto_home_max; // HACK - use hard-coded inches for now  drive_ratio; // dont move more than 10 units for autohoming
   function autoHome_abort(reason)
   {
       console.log("Aborting autoHonmng - ", reason)
       res = tmc5130_writereg(rTMC_VMax,0) ;
       res = tmc5130_readreg(rTMC_XActual);  // OK, we're giving up  = pretend where we are is now where we wanted to be.
       res = tmc5130_writereg(rTMC_XTarget,res.value)  // So update that. Then revert to position movement mode.
   }
   function autoHome_poll(position) {
        if ( typeof(updates)=='function')  updates(position); // Let mainloop know our current pos
        // have we moved more than 10 ?
        if ((starting_pos - position) > max_travel) {
            // force an abort
            autoHome_abort("Phase " + ah_phase + " - moved too far")
        }
       // Called while we are homing. Phase one - detect if we are speed.
       switch(ah_phase) {
            case 1: 
                if (ah_next == 0) {
                    // first time
                    console.log("AH - Phase 1 - getting up to speed");
                    ah_next = 1;
                }
                // Have we reached motion ramp desired speed yet?
                reg = tmc5130_readreg(rTMC_VActual);
                if (reg.status != 0 | reg.value != 0) {
                    velocity = reg.value ;  //24 bits, MSB is sign bit
                    if (velocity > 2**23) velocity -= 2**24
//                    console.log("Spd: ",velocity)
                    if ( reg.status & 0x10 ) { // we've reached speed! 
                        // Next phase - turn on stall guard, set a good tcoolthrs and increase velocity
                        console.log("Auto-homing - we've reached speed - ",velocity)
                        reg = tmc5130_readreg(rTMC_TStep);
                        tmc5130_writereg(rTMC_TCoolThrs,reg.value)
                        console.log("setting TCoolThrs : ",reg.value, " and  SGT (StallGuardThreshold) to 6"  )
                        tmc5130_writereg(rTMC_CoolConf, 6 << 16); // set SGT To some reportedly sane value. Will need to be tweaked.
                        tmc5130_writereg(rTMC_SW_Mode,1<<10) ; // Turn on Stall Guard Stop!
                        // increase speed by 10%
                        tmc5130_writereg(rTMC_VMax, Math.abs(sTMC_VMax_failsafe) * 1.1)
                        console.log("Increasing speed to : ",Math.abs(sTMC_VMax_failsafe) * 1.1)
                        ah_phase++;
                    }
                } else {  // Fake it - no TMC5130 to talk to
                    ah_phase++; // Just leap to next stage
                }
                break;
            case 2:
                if (ah_next == 1) {
                    // first time at phase 2
                    console.log("AH - Phase 2 - ramping up speed");
                    ah_next = 2;
                }
                // Actually, all we need to do now is wait to whack the stop, or go too far.
                // Have we reached motion ramp desired speed yet?
                reg = tmc5130_readreg(rTMC_VActual);
                if (reg.status != 0 | reg.value != 0) {
                    velocity = reg.value;
                    if (velocity > 2**23) velocity -= 2**24
                    if (reg.status & 0x4) { // A stall is flagged!!
                        reg = tmc5130_readreg(rTMC_XActual);
                        console.log("Stall detected!! Velocity was ", velocity,", and postition is ",reg.value,". Turning off stall guard and preparing to back off 1 tick")
                        tmc5130_writereg(rTMC_XActual, -512);   // We're messing with the zero location, and setting us 2 steps to the left of zero.
                        tmc5130_writereg(rTMC_XTarget, 1 * 175542 ) // HACK hard code for 1 inch instead of drive_ratio);      // and now we're targetting relative to the new zero. So we should retreat 1 " once I clear the stall guard stop condition.
                        tmc5130_writereg(rTMC_SW_Mode,0) ; // Turn off Stall Guard Stop! We may use it again later, but for now, just off is good enough.
                        tmc5130_writereg(rTMC_VMax, sTMC_VMax_failsafe >> 2 ); // back off at 1/4 previous speed
                        tmc5130_writereg(rTMC_RampStat,1 << 6) ; // The Stall Gaurd event stop flag/status, clear by writing 1. This should enable motion again.
                        // But we're now moving relative to the new zero, away from the stop. Call it phase 3.
                        ah_phase ++;
                    }
                } else { // Fake it - no TMC5130 to talk to
                    ah_phase++; // Just leap to next stage
                }
                break;
            case 3:
                if (ah_next == 2) {
                    // first time at phase 2
                    console.log("AH - Phase 3 - backing off 1\" ");
                    ah_next = 3;
                } 
                // Hang about for us to move 1 inch back. NOTE: The moveTo function will also detect when we get there.
                // and will fullfill it's promise when we return from this function.
                // This should be nice and slow.
                // But there is nothing to do..
                break;
        }
        return;
    } 
    // Phase one - command a motion to the left - assume we are no more than 10 inches away from the stop
    var current_pos = getPostion(); // only .val is the position, the .res are status bits.
    starting_pos = current_pos.value;
    failsafeSettings();
    tmc5130_writereg(rTMC_AMax, sTMC_AMax_autohome )
    energize(true);  // engage motor until homed

    return new Promise(function(acquired, stalled) {
        // Initiating a 'regular' moveTo, but behind the scenes, the position update checks things like stalls and velocity and 
        // changes operating paramaters of the driver as it is moving to the target position.
        // Every 100 mS this is checked BUT the chip reacts instantly to a stall or overload, so essentially
        // real-time - just that I find out in javascript main loop update time. Maybe that is 'in a jiffy'?
        moveTo(starting_pos - auto_home_max , autoHome_poll).then( (res) => {
            if (ah_next == 3) {
                console.log("Autohoming complete!");
                restoreSettings("Normal");
                acquired("Autohoming complete!")
            }
            else {
                console.log("Auto-homing failed at stage : ", ah_phase);
                energize(false);  // free-wheel motor until homed
                stalled("Auto-homing failed at stage : ", ah_phase);
            }
        }).catch( (res) => {
            // MoveTo likely will report failure as we never actually got to where we asked to go.
            // however, if we're moving into stage 3, we actually succeeded.
            if (ah_next == 3) {
                console.log("Autohoming complete!");
                restoreSettings("Normal");
                acquired("Autohoming complete!")
            }
            else {
                console.log("Auto-homing failed at stage : ", ah_phase);
                energize(false);  // free-wheel motor until homed
                stalled("Auto-homing failed at stage : ", ah_phase);
            }
        })
        ah_phase = 1;
    })
    //  let res = await promise;
    console.log("Homing started")
}


//Now onto using those.

// READY TO MOVE!!
/** The moveTo function uses a Promise to invoke the callbacks when the position is reached.
 * In other words, call moveTo with the function you want to execute when the motor gets there.
 * In the following demo code, I nest 4 callbacks and in the inner most one, refer back to the outer-
 * most one - this results in a infinite loop - but it is not recursion, as the moveTo completes,
 * then invokes the callback.
 * AND - the loop is only entered if the module is running stand-alone. If it is running as a library
 * module, the loop is not entered, and the first moveTo completes and the callback reports
 * 'Warmup Completed' and exits. Presumably, the code that invoked this module is still operating
 * and in some main loop outside of here.
 **/
{
      setup_shutdown(); // do this is stand-alone. As a module, rely on callers to wind down properly.
  //  process.on('exit', clean_exit);

    fullStop()
    .then ( function () {
        console.log("Confirmed at standstill");
        moveTo( 0 )  // Should be redunadant, as when we start up, module will have been reset and assumes it is at 0
        .then( function () { 
            console.log("Warm up complete!");
            energize(false);  // freewheel motor until homed
            if(module.id==".") // Only enter infinte loop if standalone
                moveTo(-51200).then(function goto_zero(res) {
                    console.log('move OK!')
                    moveTo(0).then(function goto_1turn(res) {
                        console.log('return OK!')
                        moveTo(51200).then(function goto_0back(res) {
                            console.log('forward OK!')
                            moveTo(00).then(function goto_1back(res) {
                                console.log('back OK!')
                                moveTo(-51200).then(goto_zero)
                            } )
                        } )
                    } )
                } )
            },
            function(res) {
            console.log('move Stalled!')
        } ) 
    })

}

