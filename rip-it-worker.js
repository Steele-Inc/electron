console.log("App started!")
var motor = require('./aux-motor.js')
var homed = false;  // This is set by the user once they have homed the fence, or it has auto-homed successfully
const jogAMax = 100;   // acceleration used when press-hold jogging
var root = document.querySelector(':root'); // need this to access the CSS color values and settings.
//Ratio between stepper revolutions and distance travelled
//Previous values for the original design with a pully system are 256*200*4.2857*.8
// 256 microsteps per step, 200 steps per revolution, 4.2857 for the gear ratio, and .8 for the pinion gear pitch diameter, So making it integer math, that is 175542 steps to move 1 inch.
const drive_ratio_in = (256*200*.5).toFixed(0);
const drive_ratio_mm = (256*200*.5/25.4).toFixed(0);
const drive_ratio_cm = (256*200*.5/2.54).toFixed(0);

var drive_ratio = drive_ratio_in;   // Start with units of inches;
console.log(`drive_ratio: ${drive_ratio} steps per inch`)

   // units change in this order - mm, cm,.in, /in [this is hard-coded in the HTML in the input form]
const units_params= { 
  "mm": { ratio: drive_ratio_mm, scale: 25.4, jog_step: '0.5'},
  "cm": { ratio: drive_ratio_cm, scale: 0.1,  jog_step: '0.05'},
  // decimal inches and fraction inches are only a display convention, not a change in ratios
  ".in": { ratio: drive_ratio_in, scale : 0.393700787401575, jog_step: '0.015625'},   
  "/in": { ratio: drive_ratio_in, scale: 1, jog_step: '0.015625'}
}

var max_step = 40 * drive_ratio_in;  // a hack to limit the high end step range.
const min_step = 0 * drive_ratio_in;  // When homed, can't go below this. if dis-engaged, it will allow.
var jogSpeed = 1000000 ;    // For now, hard code this. TODO:Add to a settings screen with the other two, above.

/** scales is pre-calculated to go from the PREVIOUS units to the CURRENT one.
  "mm": 25.4,   // prior units was /in (fracional inches) but the multiplier is the same
  "cm": 0.1,    // prior units was mm, so cm is 1/10 of that.
  ".in": 0.393700787401575,  // prior units was cm, so divide by 2.54 === 1/2.54 === 0.39370079
  "/in": 1      // prior units was decimal in, so nothing to change.
**/

function gcd_two_numbers(x, y) {
  if ((typeof x !== 'number') || (typeof y !== 'number')) 
    return false;
  x = Math.abs(x);
  y = Math.abs(y);
  while(y) {
    var t = y;
    y = x % y;
    x = t;
  }
  return x;
}


const step_size = 0.25 ;  // step each jog takes. on a raw motor, 0.25 is one quarter revolution with the above drive_ratio.
// can also come from the HTML button value.
class Keypad {
  constructor(ref_previousOperandTextElement, ref_currentOperandTextElement) {
    this.previousOperandTextElement = ref_previousOperandTextElement
    this.currentOperandTextElement = ref_currentOperandTextElement
    this.currentNumber = new Number(0);
    this.previousNumber = new Number(0);
    this.fractions = false;
    this.fraction_pending = false;  // when in fraction mode, after a DP, fractions are pending until the fraction operator is entered.
      this.clear()
    }
    getCurrentNumber(){
      return this.currentNumber;
    }
    getPreviousNumber(){
      return this.previousNumber;
    }
    clear() {
      this.currentOperand = '0';
      // this.previousOperand = ''
      this.operation = undefined
      this.currentNumber = 0;
      // this.previousNumber = 0;  // previousNumber is now used as the current position, so should not be cleared EXCEPT when autohomed or zeroed.
    }
  
    delete() {
      var c = this.currentOperand ;
      var dp = c.indexOf('.')
      // if in fraction mode, delete cancels all fractional parts.
      // note - slice of -1 removes last char, and indexOf returns -1 if not found, so if no DP, just remove last digit
      this.currentOperand = c.toString().slice(0, this.fractions? dp: -1)
      console.log(`Delete from ${c} to ${this.currentOperand}`)
      this.currentNumber = Number(this.currentOperand)
      if (this.fractions && dp != -1 && dp != c.length-1) // If in a fraction display, and there was a DP, add it back if not the last or only char
        this.appendNumber('.');
    }

    setNumber(number) {
      this.currentOperand = number.toString()
      this.currentNumber = Number(this.currentOperand) ; // I know, should be same as number passed, but this forces interpretation of the number again.
    }
    setFractions(enable) {
      this.fractions = enable;
    }
  /*
    Add the digit passed to the end of the number on displsy.
    If the digit is a Decimal point, show the decimal point.
    Prevent multiple points being entered.
    no more that 5 significant digits are supprted, and no more than
    6 decimals are supported.
  */
    appendNumber(number) {
      var dp = this.currentOperand.toString().indexOf('.'); // -1 if not found !
      if (number === '.' ) {
         if ( dp > 0) return   // already have a DP, so reject this one.
         this.currentOperand = this.currentOperand.toString() + '.'
         this.fraction_pending = true;
         // This is a display only artifact, doesn't change the currentNumber
      } 
      else if (!this.fractions || (dp==-1) || (this.fractions && dp!= -1 && this.fraction_pending)) {  // accept more digits after the DP only  
        const ints = dp >= 0 ? dp : this.currentOperand.length;
        const decs =  dp > 0 ? this.currentOperand.length - dp : 0;
        if ((ints < (dp>=0 ? 6 : 5 ) ) && (decs<=6))  // Integer number not getting too big nnnnn.ddddd
          this.currentOperand = this.currentOperand.toString() + number.toString()  // add it
        console.log(`appendNumber ${number} with currentOperand = "${this.currentOperand}" and dp = ${dp}, ints = ${ints} .decs ${decs}`)
        this.currentOperand = this.currentOperand.toString().replace(/^0+/,'0').replace(/^0([1-9]+)/,"$1")  // zap multiple leading zeroes
        this.currentNumber = Number(this.currentOperand)
      }
    }
      /**treatment. If there is nothing entered yet, and no decimal point
       * just put up the f
       * Fractions get special raction value.
       * If there is a decimal point, take the digits AFTER the point and use as nominator.
       * If less than the fraction denominator, multiply with the value of the fraction, 
       *  and REPLACE the decimal part. 
       * If the digits (nominator) amount to MORE than the denominator, do nothing.
       * @param {string} fraction A string representing the decimal notation of the unit fraction. 
       * eg 0.25 for 1/4 and 0.125 for 1/8, etc. Any fraction is acceptable, but intended for imperial franctions
       * 
       */
  
    fractionDenominator(fraction) {
      var dp = this.currentOperand.indexOf('.');
      if (dp==-1) {
        this.appendNumber(fraction) ; // no decimal yet, simpy add fraction
      } 
      else if (dp == this.currentOperand.length-1)
      { 
        this.appendNumber(fraction.slice(1)) ; // a decimal is last char, just add the fraction, but remove leading '.'.
//        console.log(`FractionDenominator called, passing on to appendNumber, result is ${this.currentOperand}` )
      }
      else  {
        // And if there IS a decimal, see if there are any digits past the decimal.
        // 123.456 dp = 3 or ( corner cases 6. or .)
        var nominator = this.currentOperand.slice(dp+1)  // nominator = 456 ( or '' )
        if (nominator == 0) nominator = 1;  // Treat 0 as blank, and blank is treated as 1
        var denominator = (1/fraction).toFixed()  // incoming fraction is something like 0.25 , so 4
        if (parseInt(nominator)>= parseInt(denominator)) return; // invalid operation
        // the digits past the decimal point can be used to make a valid fraction.
        // This ammounts to multiplying the supplied fraction by the nominator to get
        // the desired decimal number.
        var newDecimal = nominator * fraction;
        console.log(`New decimal ${newDecimal} and  this.currentOperand = "${this.currentOperand}"`)
        this.currentOperand = this.currentOperand.slice(0,dp+1)+newDecimal.toString().slice(2) ; // drop the 0.
        this.currentNumber = Number(this.currentOperand);
        this.fraction_pending=false; // fraction complete. Display as fraction, block more digits appending
      }
    }

    chooseOperation(operation) {
      this.operation = operation
      if (this.currentOperand === '') return
      if (this.previousOperand !== '') {
        this.compute()
      }
      this.previousOperand = this.currentOperand
      this.currentOperand = ''
      this.previousNumber = this.currentNumber;
      this.currentNumber = 0;
    }
    /**
     * Change the units - in other words, scale the displayed values.
     * 
     * @param {number} factor by how much to multiply the current displayed numbers 
     */
    scale(factor) {
      var prev = this.previousNumber;
      if (!isNaN(prev)) { 
        prev = (prev * factor); // Full precision number math 
        this.previousNumber = prev;
        prev = prev.toFixed(6).replace(/(0+$)|(\.0+$)/,'')
        console.log(`scaling ${this.previousOperand} using ${factor} result: ${prev} `)
        this.previousOperand = prev;
      }
      var current = this.currentNumber;
      if (!this.currentOperand=='') {
        current = current * factor;
        this.currentNumber = current;
        current = current.toFixed(6).replace(/(0+$)|(\.0+$)/,'')
        console.log(`scaling ${this.currentOperand} using ${factor} result: ${current} `)
        this.currentOperand = current; 
      }
    }
  
    compute() {
      let computation
      const prev = this.previousNumber;
      const current = this.currentNumber;
      if (isNaN(prev) || isNaN(current)) return
      switch (this.operation) {
        case '+':
          computation = prev + current
          break
        case '-':
          computation = prev - current
          break
        case '*':
          computation = prev * current
          break
        case '÷':
          computation = prev / current
          break
        default:
          return
      }
      this.currentNumber = computation
      this.operation = undefined
      this.previousNumber = 0;
      this.previousOperand = '';
      this.currentOperand = computation.toFixed(6).replace(/(0+$)|(\.0+$)/,'')
    }
  
    getDisplayNumber(number,fractions) {
      const stringNumber = number.toString()
      const integerDigits = parseFloat(stringNumber.split('.')[0])
      var decimalDigits = stringNumber.split('.')[1]
      if ((fractions) && (decimalDigits != null)){
        // do extra display processing to convert decimal places to a x/y kind of thing.
        // limit ourselves to 1/2, /4, /8, /16, /32, and /64
        const decimal = parseFloat('0.'+ decimalDigits)
        var numerator = Math.round(decimal * 64) ;
        let denom = gcd_two_numbers(numerator,64)
        numerator /= denom;
        denom = 64/denom;
        // console.log(`decimal is ${decimal} and gcd = ${denom} nummerator is ${numerator}`)
        decimalDigits = `${numerator}/${denom}`
      }
      let integerDisplay
      if (isNaN(integerDigits)) {
        integerDisplay = ''
      } else {
        // take care of the minus sign if number is between -0.99999 and 0, as the integer part is -0, which shows as 0.
        integerDisplay = ((number<0) && (integerDigits==0 )?'-':'' )+ integerDigits.toString()
      }
      if (decimalDigits != null) {
        return `${integerDisplay}.${decimalDigits}`
      } else {
        return integerDisplay
      }
    }
  
    updateDisplay() {
      this.currentOperandTextElement.innerText = this.currentOperandd == '' ? '' :
        `${this.getDisplayNumber(this.currentOperand, this.fractions && !this.fraction_pending)}`
      if (this.operation != null) {
        this.previousOperandTextElement.innerText =
          `${this.getDisplayNumber(this.previousOperand)} ${this.operation}`
      } else {
        this.previousOperandTextElement.innerText = `${this.getDisplayNumber(this.previousOperand,this.fractions)}`
      }
    }
  }   // here ends Keypad
  
  const current_unit_fld=document.querySelector("#current_units");  //Grab the node that is int the HTML representing the input field for current units.
  const numberButtons = document.querySelectorAll('[data-number]')
  const fracButtons = document.querySelectorAll('[frac-number]')
  const operationButtons = document.querySelectorAll('[data-operation]')
  const enterButton = document.querySelector('[data-enter]')
  const deleteButton = document.querySelector('[data-delete]')
  // const stopButton = document.querySelector('[data-stop]')
  const allStopButton = document.querySelector('.all-stop')
  const previousOperandTextElement = document.querySelector('[data-current-position]')
  const currentOperandTextElement = document.querySelector('[data-next-position]')
  
  const keypad = new Keypad(previousOperandTextElement, currentOperandTextElement)
  
function fracButtonReset(evt) {
    // an EventListener used to handle cleaning up after a fraction button is pressed.
    fracButtons.forEach(frac => {
      frac.innerHTML = frac.innerHTML.replace(/^\//,"1\/")
      frac.removeEventListener("click", fracButtonReset)
      // console.log(frac.innerHTML, frac.innerHTML.replace(/1\//,"\/"))
    })
  }

  numberButtons.forEach(button => {
    if (button.hasAttribute("decimal-point"))
     { // Special case the decimal point, as extra actions are required when in fraction mode.
      button.addEventListener('click', () => {
        keypad.appendNumber(button.value)
  //      keypad.compute()
        keypad.updateDisplay()
        current_units=current_unit_fld.value;

        if (current_units == "/in")
        {  // We are in fraction mode. User pressed deciaml point. Blank all the fraction button nominators.
          // NOTE: They get reset when move is initiated, or clear/all-clear is pressed.
          console.log("Fixing frac btns")
          fracButtons.forEach(frac => {
            frac.innerHTML = frac.innerHTML.replace(/1\//,"\/")
            frac.addEventListener('click', fracButtonReset)
            // console.log(frac.innerHTML, frac.innerHTML.replace(/1\//,"\/"))
          })
        }
        })
  
    }
    else {
      button.addEventListener('click', () => {
      keypad.appendNumber(button.value)
//      keypad.compute()
      keypad.updateDisplay()
      })
    } 
  })
  
  fracButtons.forEach(button => {
    button.addEventListener('click', () => {
      /**
       * Fractions get special treatment. If there is nothing entered yet, and no decimal point
       * just put up the fraction value.
       * If there is a decimal point, take the digits AFTER the point and use as nominator.
       * If less than the fraction denominator, multiply with the value of the fraction, 
       *  and REPLACE the decimal part. 
       * If the digits (nominator) amount to MORE than the denominator, do nothing.
       */
      keypad.fractionDenominator(button.value)
//      keypad.compute()
      keypad.updateDisplay()
    })
  })
/*   stopButton.addEventListener('click', button => {
    keypad.clear()
    keypad.updateDisplay()
  })
 */  
  var delTimerId = 0, dels = 0, delTouch = 0

  function delStillPressed()
  {
    dels ++;
    if (dels < 3) { // remove one per period
      keypad.delete()
      keypad.updateDisplay()
    }
    else if ( dels == 3 ) {  // Ok, they are pressing and holding - initiate a all clear
        keypad.clear()
        keypad.updateDisplay()
    }
  }

  deleteButton.addEventListener('click', button => {  // Keep this for remote GUI interaction, which masks touch start and end.
    if (delTouch == 0) {  // if no touch processing is going on, it's a mouse click (most likely)
      keypad.delete()
      keypad.updateDisplay()
  } else {
    delTouch = 0
  }
  })

  deleteButton.addEventListener("touchstart", (evt) => {
    delTouch = 1;
    if (dels  == 0) {// if this is first press, start implementing repeat
      delTimerId = setInterval( delStillPressed,100);
    }
  })

  deleteButton.addEventListener("touchend", (evt) => {
     clearInterval(delTimerId);
     if (dels == 0) { // a short press is just a single del
      keypad.delete()
      keypad.updateDisplay()
     }
     dels = 0;
  })

  function allStop(emergency)
  {
    motor.fullStop(emergency).then( res => {
      show_stop(false);
      if(emergency) {  // if called in emergency, then nornmal cleanup after us may not happen. update display, just in case.
          setNewPosition();  // once we're stopped, the variable position update IS the new position
      }
      console.log("Confirmed - full stop in GUI:");
    });
  }
  allStopButton.addEventListener('click', allStop )

  function positionUpdate(newPos) {
    var res = 0;
    keypad.setNumber(Math.round(newPos*1000000/drive_ratio)/1000000);
    keypad.updateDisplay()
    /** EXPERIMENT - don't test limits
    if (homed && ( (newPos > max_step ) || (newPos < min_step ))) {
      console.log(res = `Travel Limit Reached! ${homed} , newpos ${newPos} max:${max_step}, min: ${min_step}`)
       allStop(true)
       promptDialog('LimitWarning', function limitWarningAction(result) {
        //disengageAction("OK")
       })   
    }
    **/
    return res; // 0 if OK position, some error string if not.
  };

  function setNewPosition( newPosition ) {
    if (!isNaN(newPosition) )    keypad.setNumber(Math.round(newPosition*1000000/drive_ratio/1000000));
    keypad.chooseOperation();   // Current (clunky) way to update the Position part of the display
    keypad.updateDisplay()
  }
  var buttonTimerId = 0, jogs = 0 , dir = 0 ; // these are global variables as each button can only be pressed one at a time.

  function jogStillPressed()
  {
    //console.log("Jog Still Pressed")
    if (jogs++ == 3 ) {  // Ok, they are pressing and holding - initiate a movement
      // after 4, command a movement
      motor.energize(true);  // turn on motor, in case we were freewheeling
      // But also, want to slowly accelerate to a moderate speed. Set in failsafe mode, at least
      motor.turnAt(jogSpeed * dir, positionUpdate).then( (jog_done) => {
        console.log("jog-hold end complete", jog_done)
        motor.energize(homed);  // freewheel if not homed
        setNewPosition();  // once we're stopped, the variable position update IS the new position

      }).catch( (jog_end) => {
        console.log("jog-hold end caught", jog_end)
        motor.energize(homed);  // freewheel if not homed
        setNewPosition();  // once we're stopped, the variable position update IS the new position
      })
    }
  }
  function jogDone(jd_res){
    show_stop(false);
    motor.energize(homed);  // freewheel if not homed
    setNewPosition();  // once we're stopped, the variable position update IS the new position
    console.log("Jogged position reached : ",jd_res);
  }
  operationButtons.forEach(button => {
    /* If a simple 'click' happened - that is a press and release inside the button, 
       inside a short 'single click' timer, then move the motor a 'jog' in one or 
       other direction, depending on the exact button pressed. The ammount depends on
       if a value was entered *before* the jog key was pressed. If so, move by that 
       ammount, otherwise some small step like 1/4"
       */
    button.addEventListener('click', () => {
      if(currentOperandTextElement.innerText=="") {
        keypad.setNumber(button.value) // NOTE - the stepsize is SIGNED, so if negative, adding it works.
        keypad.chooseOperation('+')  // add or substract the step size from the current position. 
      }
      else {
        // A value was entered, so move in the direction pressed
        keypad.chooseOperation(button.innerText=='<'? '-':'+')  // add or substract the step size from the current position.
      }
       keypad.updateDisplay()
      target = keypad.getPreviousNumber();
      console.log("Jog Pressed: ",target)
      show_stop(true);
      motor.energize(true);  // whether we have homed or not, we need to move 
      motor.moveTo((drive_ratio * target).toFixed(0),positionUpdate).then(jogDone).catch(jogDone);
    })
    /* but we also want to support a 'press and move while held' function
    */
   button.addEventListener("touchstart", (evt) => {
      dir = button.innerText.includes('<')? -1:+1;
      if (jogs == 0) // prevent other jog button restarting jog-hold
        buttonTimerId = setInterval(jogStillPressed,100);
    })
    button.addEventListener("touchend", (evt) => {
       clearInterval(buttonTimerId);
       if (jogs >= 4) {  // we started moving
        allStop(true); // The turn.catch does the rest of the clean up, if needed.
      }
       jogs = 0;
    })
/*  Dont use mouse if on touch
  button.addEventListener("mousedown", (evt) => {
      evt.preventDefault();
      dir = button.innerText=='<'? -1:+1;
      jogs = 0;
      console.log("Mousedown - moving ", dir);
      buttonTimerId = setInterval(jogStillPressed,100);
    })
    button.addEventListener("mouseup", (evt) => {
       clearInterval(buttonTimerId);
       if (jogs >= 4) {  // we started moving
        allStop(true);
        setNewPosition();  // once we're stopped, the variable position update IS the new position
      }
       jogs = 0;
    })
  */
  })

    const memButtons = document.querySelectorAll('[memory-key]')
  memButtons.forEach(button => {
    if (val = localStorage.getItem(button.innerText)) button.value = val ; // Only override HTML coded default IF stored value is valid.
    // NOTE: Button value is stored in steps, so needs to be wrangled to current units before use or display.
    button.addEventListener('click', () => {
      if(currentOperandTextElement.innerText=="") {
        console.log(`M-key ${button.innerText} pressed: ${button.value}`)
        keypad.setNumber(Math.round(button.value*1000000/drive_ratio)/1000000);  // do the magic manipulation to get 6 decimal digits
        keypad.chooseOperation(button.innerText)
        keypad.compute()
        keypad.updateDisplay()
        show_stop(true);
        motor.energize(true);  // Turn on as we are about to move
        // REMEMBER - Mem Keys store the absolute step number.
        motor.moveTo( button.value,positionUpdate).then(res =>{
          show_stop(false);
          motor.energize(homed);  // freewheel if not homed
          setNewPosition();  // once we're stopped, the variable position update IS the new position
          console.log("Mem position reached : ",res);
        });
      }
      else {
        button.value = keypad.getCurrentNumber() * drive_ratio;
        localStorage.setItem(button.innerText,button.value);
        console.log(`M-key ${button.innerText} updated: ${button.value} Stored`)
        keypad.chooseOperation(button.innerText)
        keypad.compute()
        keypad.updateDisplay()
      }
    })
  })

  enterButton.addEventListener('click', button => {
    function moveDone(res){
      show_stop(false);
      motor.energize(homed);  // freewheel if not homed
      console.log("Entered position reached : ",res);
      setNewPosition();  // once we're stopped, the variable position update IS the new position
    }  
    var target = currentOperandTextElement.innerText
    if (target == '' ) return;
    var dest = keypad.getCurrentNumber()
    keypad.chooseOperation()
 //   keypad.compute()
    keypad.updateDisplay()
    console.log(`Enter Pressed - target ${target} dest = ${dest}`)
    show_stop(true);
    motor.energize(true);  // We're about to move, allow this
    motor.moveTo( (drive_ratio * dest).toFixed(0),positionUpdate)
    .then(moveDone)
    .catch(moveDone) // Don't matter which exit we got, for now.
  })

   // This function walks through a panel's range_sliders and attaches the range value to the bubble so 
  // when the range changes the bubble is updated, and apply button is enabled.
  var rangeSlider = function(sliders){ 
    if (sliders) { 
      panel = sliders[0].closest(".panel")
      sliders.forEach( wrap => {
        const range = wrap.querySelector(".range-slider__range");
        const bubble = wrap.querySelector(".range-slider__value");
        if ( bubble) bubble.textContent = range.value;  // When setting up connection, force this first update
        range.addEventListener('input', (evt) => {
            // listen for an input change, and if there is a bubble showing its value, update it.
            if (bubble) bubble.textContent = range.value; // and every time, if there is a bubble, update it.
            // also, when an input changes, there is something to apply, so enable 
            apply_but = evt.target.closest(".panel").querySelector(".panel-apply")
            if (apply_but) apply_but.disabled=false; 
            
          });
          if ('number' == range.type ) { // Add extra listeners to numbers to make adjusting them responsive to touch gestures
            var active = 0, old = 0 ; // Declare local scope variables for the event handlers to use.
            range.addEventListener('touchstart', (evt) => {
              old = evt.target.value;
              active = evt.touches[0].clientX; 
            });
            range.addEventListener('touchend', (evt) => {
              active = 0; 
              if(old!=evt.target.value) evt.target.dispatchEvent(new Event('input'))
            });
            // it turns out that move events only get triggered if a touchstart happens in the element, first.
            // and then, they keep coming until a touchend event happens, then it goes quiet again.
            range.addEventListener('touchmove', (evt) => {
                delta = active-evt.touches[0].clientX;
                active = evt.touches[0].clientX; 
                if(Math.abs(delta)>10) delta*=20; else if (Math.abs(delta)> 5) delta*=5; 
                  evt.target.value=(evt.target.value-delta) < evt.target.min ? evt.target.min :
                    ((evt.target.value-delta) > evt.target.max ? evt.target.max : evt.target.value-delta);
            });
          }
          });
    }
  };
  /** There are standard panels in the application that all use the same button - apply, revert, save, load, reset 
   * there are common interactions between the states of the buttons, and there are hidden fields on the panel
   * to track if any elements are 'dirty' - ie touched since last save or apply.
   * So best practice is to hook all the same functions to the same event, and add an additional unique listener for
   * the extra things that need to happen.
   * 
   * Also, range sliders have 'bubbles' which show the value of the range - otherwise no exact number can be known.
  */
  const settings_panel = document.querySelector("#settings-panel");
  const settings_sliders = settings_panel?settings_panel.querySelectorAll('.range-slider'):settings_panel;
  const applySettings = document.querySelector('#settings-apply');
  applySettings.addEventListener('click', panel_apply);
  applySettings.addEventListener('click', settings_panel_apply);
  document.querySelector('#settings-revert').addEventListener('click', panel_revert);
  document.querySelector('#settings-save').addEventListener('click', panel_save);
  document.querySelector('#settings-reset').addEventListener('click', panel_reset);
  loadSettings = document.querySelector('#settings-load');
  loadSettings.addEventListener('click', panel_load);

 
/**
 * These are all the common panel button handlers. They take care of the housekeeping.
 * If special processing is also needed - eg, on apply, typically, add an extra listener for click on the apply
 * that calls the uniqu function AS WELL.
 */
function panel_revert(evt) {  // panel is ancestor of the evt target
  // move stuff out of the hidden shadow fields into their inputs
  // if there is a seperate value node, also update that.
  panel = evt.target.closest(".panel")
  panel.querySelectorAll('.range-slider').forEach(field => {
    value = field.querySelector(".range-slider__range").value =
      field.querySelector("[type=hidden]").value; // assign AND remember
    if (val = field.querySelector(".range-slider__value")) { // test AND remember
      val.textContent = value;  // use memorized node and val
    }
  })
  // if values are reverted, they can't be applied anymore
  panel.querySelector('.panel-apply').disabled = true;
  // But the save button may or may not be relevant, depending on intervening 'applies'
  if ("false" == panel.querySelector('.panel-dirty').value) {
    panel.querySelector('.panel-save').disabled = true;
  }
}
  
function panel_apply(evt) {
  // move stuff from input fields into the hidden shadow fields
  // invoke the driver 'apply' function
  // and adjust the buttons - apply goes 'off', save goes 'on'
  panel = evt.target.closest(".panel")
  const sliders = panel.querySelectorAll('.range-slider')
  sliders.forEach(field => {
    field.querySelector("[type=hidden]").value =
      field.querySelector(".range-slider__range").value;
  });
//  motor.setSettings(evt.target.closest(".panel").querySelectorAll('.range-slider')); // pass a collection of sliders to the settings handler
  panel.querySelector(".panel-apply").disabled = true;  // it's applied,
  panel.querySelector(".panel-save").disabled = false;  // so now can be saved,
  panel.querySelector(".panel-dirty").value = true;     // and in any case, data is 'dirty' (different than last save)
}

  function panel_save(evt) {
    // should only happen after apply? 
    //move stuff from input fields into the hidden shadow fields
    panel = evt.target.closest(".panel")
    // Now we know what panel we are on, store all the hidden fields into storage, by their name.
    const sliders = panel.querySelectorAll('.range-slider')
    sliders.forEach(field => {
      param = field.querySelector("[type=hidden]")
      console.log(` ${param.id} = ${param.value}` )
      localStorage.setItem(param.id,param.value )
    });
    panel.querySelector(".panel-save").disabled=true;   // Stuff saved to file,
    panel.querySelector(".panel-dirty").value = false;  // so no longer dirty.
  }
  function panel_load(evt) {
    // could happen anytime
    // move stuff from storage into the hidden shadow fields
    panel = evt.target.closest(".panel")
    // Now we know what panel we are on, load all the hidden fields from storage, by their name.
    const sliders = panel.querySelectorAll('.range-slider')
    sliders.forEach(field => {
      param = field.querySelector("[type=hidden]")
      param.value  = localStorage.getItem(param.id)
      console.log(` ${param.id} = ${param.value}` )
      field.querySelector(".range-slider__range").value = param.value;
      if (val = field.querySelector(".range-slider__value")) { // test AND remember
        val.textContent = param.value;  // use memorized node and val
      }
    });
    panel.querySelector(".panel-save").disabled=true;   // Stuff now matches saved values, so no need to save.
    panel.querySelector(".panel-apply").disabled=false;   // Stuff can be applied,
  }

  function panel_reset(evt) {
    // copy the reset atribute values in the HTML into the current values
    panel = evt.target.closest(".panel")
    const sliders = panel.querySelectorAll('.range-slider')
    sliders.forEach(field => {
      const reset = field.querySelector('input').attributes["reset"];
      if (reset) {
        console.log("resetting ",field.children[1].id," to ", reset.nodeValue)
        field.querySelector(".range-slider__range").value = reset.nodeValue;
        if (val = field.querySelector(".range-slider__value")) { // test AND remember
          val.textContent = reset.nodeValue;  // use memorized node and val
        }
      }
    });
    panel.querySelector(".panel-apply").disabled=false;   // Stuff can be applied,
    panel.querySelector(".panel-dirty").value = true;  // so possilbly dirty.
  }

  function settings_panel_apply(evt) {
    motor.setSettings(evt.target.closest(".panel").querySelectorAll('.range-slider')); // pass a collection of sliders to the settings handler
  }

  // For panels with ranges, add hooks to the bubble showing the range value.
  rangeSlider(settings_sliders);
  // Load tunigs from storage, then apply them
  loadSettings.click();  // Force restore of the stored values
  applySettings.click();  // At start up, capture the inputs to the shadow fields.
  
  const tunings = document.querySelector("#tunings-panel").querySelectorAll('.range-slider');  
  const applyTunings = document.querySelector('#tunings-apply');
  applyTunings.addEventListener('click', panel_apply); // the default handler
  applyTunings.addEventListener('click', tunings_apply); // and the special on that does the real work.
  document.querySelector('#tunings-reset').addEventListener('click', panel_reset); 
  document.querySelector('#tunings-revert').addEventListener('click', panel_revert);
  document.querySelector('#tunings-save').addEventListener('click', panel_save);
  loadTunings = document.querySelector('#tunings-load')
  loadTunings.addEventListener('click', panel_load);
  
  function tunings_apply(evt) { 
    // The only tuning at the moment is travel limits
    max_step = (document.querySelector('#travel_max').value * drive_ratio_in / 10).toFixed();  //FIXME Travel limits are in 1/10 inches
    auto_max = (document.querySelector('#auto_home_max').value * drive_ratio_in / 10).toFixed();
    console.log("Max_Step is ",max_step, " Auto_Home_Max is ", auto_max)
    motor.setLimits(min_step, max_step, auto_max);
  }

  // Load tunigs from storage, then apply them
  rangeSlider(tunings);
  loadTunings.click();  // Force restore of the set limits
  applyTunings.click()  // At start up, capture the inputs to the shadow fields.

  /*
  Startup panel stuff
  */

  rangeSlider(document.querySelector("#startup-panel").querySelectorAll('.range-slider'));

  rangeSlider(document.querySelector("#new-settings-panel").querySelectorAll('.range-slider'));

  /** Show / hide the e-stop button. 
   * CSS takes care of the display attributes, and showing the STOP is done in the display handler.
   * But once we've reached target, or STOP is pressed, we handle it, as STOP should only be
   * turned off once we know we've stopped.
 */
  function show_stop(mode) {
   if (mode) { // to minimize redraw glitches, turn off elements first, then on. Which changes depending on the mode.
      document.querySelector("#runmode-stop").checked=true;
    }
    else { // reverse the order, so we go to showing nothing, then tuen on what is needed.
      document.querySelector("#runmode-run").checked=true;
    }
  }
  
   document.querySelector("#ChipVersion").textContent = motor.vTMC_Version.name;
  
/**
  promptDialog is a wrapper function to show a modal dialog box.
  @param {id} dialogIdToShow  is the id of the \<dialog\> element to show
  @param {function} cb  is the function to call when the dialog is closed
  @returns nothing.
  
  Until the dialog box is closed, no other GUI interactions are possible. However, this
  function is NOT blocking. 
**/
  function promptDialog(dialogIdToShow, cb) {
    var pDialog = document.getElementById(dialogIdToShow)
    if (pDialog.open) return;
    var fe = function(e) {
      cb(pDialog.returnValue)
      pDialog.removeEventListener("close", fe)
    }  
    var x = pDialog.showModal()
    pDialog.addEventListener('close', fe)
  }
  function disengageAction(result) {
    if (result == 'OK') {
      motor.energize(false)
      motor.failsafeSettings();
      homed = false; 
      document.querySelector("#disengage").disabled=true;
      document.querySelector("#homed-flag").hidden=false;
      document.querySelector("#auto-homing").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_bg');
      document.querySelector("#homing-zero").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_bg');      }
      document.querySelector("#auto-homing").disabled=false;
    }
  document.querySelector("#disengage").addEventListener('click', evt => {
    promptDialog( 'DisengageWarning' ,  disengageAction )
  });

document.querySelector("#homing-zero").addEventListener('click', evt => {
  promptDialog( 'ZeroWarning' , function homingZeroAction(result) {
    if (result == 'OK') {
      motor.homeSetZero();  // Reset chip, which makes here === 0
      applySettings.click()
      setNewPosition(0);  // once we're homed, assume we are at 0
      document.querySelector("#disengage").disabled=false;
      document.querySelector("#auto-homing").disabled=true;
      document.querySelector("#homed-flag").hidden=true;
      document.querySelector("#homing-zero").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_ok');
      document.querySelector("#auto-homing").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_bg');

      homed = true;
    }
  })
});
function performAutoHome()
{
  motor.autoHome(drive_ratio,positionUpdate).then( auto_home_result =>   // Reset chip, which makes here === 0
    {  // this needs to only run if autohome succeeds... 
      console.log("Auto-Home promise returned ", auto_home_result)
      document.querySelector("#disengage").disabled=false;
      document.querySelector("#auto-homing").disabled=true;
      document.querySelector("#auto-homing").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_ok');
      document.querySelector("#homing-zero").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_bg');
      document.querySelector("#homed-flag").hidden=true;
      homed = true; 
      setNewPosition(); // Grab the last reported positionUpdate, and make it current.
      document.querySelector('#tab1').checked=true; // and switch to keypad display when success!
    }).catch( auto_home_result => { // and when it fails, handle it.
      console.log("Auto-Home promise stalled :", auto_home_result)
      document.querySelector("#disengage").disabled=true;
      document.querySelector("#auto-homing").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_bg');
      document.querySelector("#homing-zero").style.backgroundColor = getComputedStyle(root).getPropertyValue('--panelbutton_bg');
      document.querySelector("#homed-flag").hidden=false;
      homed = false;
    })   
}

document.querySelector("#auto-homing").addEventListener('click', mse_evt => {
    promptDialog('AutoHomeWarning', function autoHomingAction(result) {
      if(result == 'OK')      performAutoHome();
    })
  });

  document.querySelector("#startupAuoHome").addEventListener('click', mse_evt => { performAutoHome() } )
  document.querySelector("#settingAuoHome").addEventListener('click', mse_evt => { performAutoHome() } )

  // Handle the units changing.
  function unitsChanged(unit_evt) {
    // any click in this area causes the units to go to the next one.
    // And all that a units change does is alter the drive-ratio.
    // However, we also need to take care of what is currently shown on the display.
    // FIXME: How to handle stored M values? They are intednted to be memorized positions...
    current_units=current_unit_fld.value = unit_evt.target.value;
    new_ratio = units_params[current_units].ratio;
    console.log(` changing units: new units are ${current_units} with drive ratio ${new_ratio}`)
    keypad.setFractions(current_units.indexOf('/')!= -1) // turn on or off fractions display
    // units change in this order - mm, cm,.in, /in
    // so the new units also lets us know what scale to apply on the display to switch ti the new units.
    keypad.scale(units_params[current_units].scale)
    keypad.updateDisplay();
    fracButtonReset();  // Just in case we were in the middle of entering a fraction
    drive_ratio = new_ratio;  // This is it - we are now moving in new units!
    // Patch up the Jog value to step in appropriate units.
    document.querySelectorAll("[data-operation]").forEach( btn => 
      { 
        if (btn.className.includes("jog-left")) 
          btn.value = units_params[current_units].jog_step * -1 ;
        else 
          btn.value = units_params[current_units].jog_step ;
        console.log(`updating jog ${btn} to step ${btn.value}`);
      })
    // Also - in fraction mode, change legend on the decimal point button to be [x/y]
    document.querySelectorAll("[decimal-point]").forEach( btn => 
      { // for now, we only know of one decimal point button, but other panels may be defined in the future. Might as well look for all of them.
        if (current_units == "/in") {
          btn.innerHTML = "x/y";    // FIXME: May need to tweak layout of font, etc, as well.
        }
        else {
          btn.innerHTML = ".";
        }
        console.log(`updating decimal point to  ${btn.innerHTML}`);
      })
  }
  document.querySelectorAll('[name="units"]').forEach(units => {
    units.addEventListener('change', unitsChanged )
  })

  setNewPosition(0);  // once we're started, assume we are at 0
  motor.failsafeSettings(); // Until we have executed the homing function, stay safe.
  
  document.querySelector(".demo-button").addEventListener('click',run_demo);

/**
 * 
 * @param {*} new_units This is one of the unit designatore in the HTML code.
 * 
 * Current units are unitmm, unitcm, unitin, and unitfrac.
 * Using this method to do the inital setting as this ensures that all the event handling code 
 * and other specail cases are handled - eg, the jog steps set, the Mem-Key calibrated, etc.
 */
  function setStartupUnits(new_units) {
    const event = new MouseEvent('click', {
      view: window,
      bubbles: true,
      cancelable: true
    });
    const cb = document.getElementById(new_units);
    const cancelled = !cb.dispatchEvent(event);
  
    if (cancelled) {
      // A handler called preventDefault.
      console.log("cCould not set default units to '.in'");
    } else {
      // None of the handlers called preventDefault.
      console.log("default units set to '.in'");
    }
  }
  setStartupUnits("unitin");

  const max_mem_num = 3;    // Mem buttons could be variable. for now, hard code it, but in the future could examine the DOM to see how many "mem-key' buttons there are.
  function run_demo(){
    // Simply cycle through the Mem Keys one at a time
    // memButtons[2].click() // too simple - can't tell when it is complete.
    function demo_end(res) {
      show_stop(false);
      motor.energize(homed);  // freewheel on if not homed
      setNewPosition();  // once we're stopped, the variable position update IS the new position
      console.log("Demo Aborted : ",res)
    }
    function demo_val( m_n ) {
      const m_but = memButtons[m_n]
      const m_val = m_but.value
      keypad.setNumber(Math.round(m_val*1000000/drive_ratio)/1000000);  // do the magic manipulation to get 6 decimal digits
      keypad.chooseOperation(m_but.innerText)
      keypad.compute()
      keypad.updateDisplay()
      return m_val
    }

    function demo_step( step_m ) {
      let demo_M1 = new Promise( (resolve, reject) => {
        setTimeout( function () {
          // when timeout is over, make sure we've not pressed stop, first.
          if (!document.querySelector("#runmode-run").checked) {
            motor.moveTo(demo_val(step_m),positionUpdate).then( (move_res) => { 
              resolve(step_m ) }).catch( (move_rej) => {
              reject(-step_m) } ) }
          else reject (-step_m)
          }
            , 1500) // Delay between demo movements 1.5s
      });
      demo_M1.then( function(m_res)  {
        console.log(`Next step ${m_res}`)
        demo_step(m_res >= (max_mem_num-1) ? 0 : m_res+1 )
      }).catch ((m_fail)=> {
        console.log(`demo_step done at ${m_fail}`)
        demo_end(m_fail)
      })
    }
    show_stop(true);
    motor.energize(true);  // Turn on as we are about to move
    // REMEMBER - Mem Keys store the absolute step number.
    demo_step(1);
    /**  This code works, but has not delay between moves...
    motor.moveTo( demo_val(1),positionUpdate).then( function demo_M2(res) {
      motor.moveTo( demo_val(2),positionUpdate).then( function demo_M3(res) {
        motor.moveTo( demo_val(3),positionUpdate).then( function demo_M4(res) {
          motor.moveTo( demo_val(0),positionUpdate).then( function demo_M0(res) {
            motor.moveTo( demo_val(1),positionUpdate).then( demo_M2 )
            .catch( demo_end
          ).catch( demo_end )}
        ).catch( demo_end )}
      ).catch( demo_end )}
    ).catch( demo_end )}
    )
    **/
  }
