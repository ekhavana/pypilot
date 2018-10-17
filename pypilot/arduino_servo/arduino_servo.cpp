/* Copyright (C) 2017 Sean D'Epagnier <seandepagnier@gmail.com>
 *
 * This Program is free software; you can redistribute it and/or
 * modify it under the terms of the GNU General Public
 * License as published by the Free Software Foundation; either
 * version 3 of the License, or (at your option) any later version.
 */

#include <stdint.h>
#include <unistd.h>
#include <math.h>

#include <stdio.h>
#include <errno.h>

#include <sys/time.h>

#include "arduino_servo.h"

enum commands {COMMAND_CCODE = 0xc7, RESET_CCODE = 0xe7, MAX_CURRENT_CCODE = 0x1e, MAX_CONTROLLER_TEMP_CCODE = 0xa4, MAX_MOTOR_TEMP_CCODE = 0x5a, RUDDER_RANGE_CCODE = 0xb6, REPROGRAM_CCODE = 0x19, DISENGAUGE_CCODE = 0x68, MAX_SLEW_CCODE = 0x71, CURRENT_CORRECTION_CCODE = 0xdb, VOLTAGE_CORRECTION_CCODE = 0x4e};
enum results {CURRENT_RCODE = 0x1c, VOLTAGE_RCODE = 0xb3, CONTROLLER_TEMP_RCODE = 0xf9, MOTOR_TEMP_RCODE = 0x48, RUDDER_SENSE_RCODE = 0xa7, FLAGS_RCODE = 0x8f, MAX_CURRENT_RCODE = 0x1e, MAX_CONTROLLER_TEMP_RCODE = 0xa4, MAX_MOTOR_TEMP_RCODE = 0x5a, RUDDER_RANGE_RCODE = 0xb6, MAX_SLEW_RCODE = 0x71, CURRENT_CORRECTION_RCODE=0xdb, VOLTAGE_CORRECTION_RCODE=0x4e};

const unsigned char crc8_table[256]
= {
    0x00, 0x31, 0x62, 0x53, 0xC4, 0xF5, 0xA6, 0x97,
    0xB9, 0x88, 0xDB, 0xEA, 0x7D, 0x4C, 0x1F, 0x2E,
    0x43, 0x72, 0x21, 0x10, 0x87, 0xB6, 0xE5, 0xD4,
    0xFA, 0xCB, 0x98, 0xA9, 0x3E, 0x0F, 0x5C, 0x6D,
    0x86, 0xB7, 0xE4, 0xD5, 0x42, 0x73, 0x20, 0x11,
    0x3F, 0x0E, 0x5D, 0x6C, 0xFB, 0xCA, 0x99, 0xA8,
    0xC5, 0xF4, 0xA7, 0x96, 0x01, 0x30, 0x63, 0x52,
    0x7C, 0x4D, 0x1E, 0x2F, 0xB8, 0x89, 0xDA, 0xEB,
    0x3D, 0x0C, 0x5F, 0x6E, 0xF9, 0xC8, 0x9B, 0xAA,
    0x84, 0xB5, 0xE6, 0xD7, 0x40, 0x71, 0x22, 0x13,
    0x7E, 0x4F, 0x1C, 0x2D, 0xBA, 0x8B, 0xD8, 0xE9,
    0xC7, 0xF6, 0xA5, 0x94, 0x03, 0x32, 0x61, 0x50,
    0xBB, 0x8A, 0xD9, 0xE8, 0x7F, 0x4E, 0x1D, 0x2C,
    0x02, 0x33, 0x60, 0x51, 0xC6, 0xF7, 0xA4, 0x95,
    0xF8, 0xC9, 0x9A, 0xAB, 0x3C, 0x0D, 0x5E, 0x6F,
    0x41, 0x70, 0x23, 0x12, 0x85, 0xB4, 0xE7, 0xD6,
    0x7A, 0x4B, 0x18, 0x29, 0xBE, 0x8F, 0xDC, 0xED,
    0xC3, 0xF2, 0xA1, 0x90, 0x07, 0x36, 0x65, 0x54,
    0x39, 0x08, 0x5B, 0x6A, 0xFD, 0xCC, 0x9F, 0xAE,
    0x80, 0xB1, 0xE2, 0xD3, 0x44, 0x75, 0x26, 0x17,
    0xFC, 0xCD, 0x9E, 0xAF, 0x38, 0x09, 0x5A, 0x6B,
    0x45, 0x74, 0x27, 0x16, 0x81, 0xB0, 0xE3, 0xD2,
    0xBF, 0x8E, 0xDD, 0xEC, 0x7B, 0x4A, 0x19, 0x28,
    0x06, 0x37, 0x64, 0x55, 0xC2, 0xF3, 0xA0, 0x91,
    0x47, 0x76, 0x25, 0x14, 0x83, 0xB2, 0xE1, 0xD0,
    0xFE, 0xCF, 0x9C, 0xAD, 0x3A, 0x0B, 0x58, 0x69,
    0x04, 0x35, 0x66, 0x57, 0xC0, 0xF1, 0xA2, 0x93,
    0xBD, 0x8C, 0xDF, 0xEE, 0x79, 0x48, 0x1B, 0x2A,
    0xC1, 0xF0, 0xA3, 0x92, 0x05, 0x34, 0x67, 0x56,
    0x78, 0x49, 0x1A, 0x2B, 0xBC, 0x8D, 0xDE, 0xEF,
    0x82, 0xB3, 0xE0, 0xD1, 0x46, 0x77, 0x24, 0x15,
    0x3B, 0x0A, 0x59, 0x68, 0xFF, 0xCE, 0x9D, 0xAC
};

static inline uint8_t crc8_byte(uint8_t old_crc, uint8_t byte){
    return crc8_table[old_crc ^ byte];
}

static inline uint8_t crc8_with_init(uint8_t init_value, uint8_t *pcBlock, uint8_t len)
{
    uint8_t crc = init_value;
    while (len--)
        crc = crc8_byte(crc, *pcBlock++);
    return crc;
}

static uint8_t crc8(uint8_t *pcBlock, uint8_t len) {
    return crc8_with_init(0xFF, pcBlock, len);
}

ArduinoServo::ArduinoServo(int _fd)
    : fd(_fd)
{
    in_sync_count = 0;
    out_sync = 0;
    in_buf_len = 0;
    max_current = 0;
    params_set = 0;

    flags = 0;
}

bool ArduinoServo::initialize(int baud)
{
    int cnt = 0;
    bool data = false;

    // flush device data
//    while(read(fd, in_buf, in_buf_len) > 0);

    while (!(flags & SYNC) || out_sync < 20) {
        raw_command(1000); // ensure we set the temp limits as well here
        if(poll()>0) {
            while(poll());
            data = true;
        } else
            usleep(1e6 * 120 / baud);
        cnt++;
        if(cnt >= 400 && !data) {
            printf("arduino servo fail no data\n");
            return false;
        }
        if(cnt == 1000) {
            printf("arduino servo fail sync\n");
            return false;
        }
    }
    return true;
}

void ArduinoServo::command(double command)
{    
    command = fmin(fmax(command, -1), 1);
    raw_command((command+1)*1000);
}

int ArduinoServo::process_packet(uint8_t *in_buf)
{
    uint16_t value = in_buf[1] + (in_buf[2]<<8);
    switch(in_buf[0]) {
    case CURRENT_RCODE:
        current = value / 100.0;
        //printf("servo current  %f\n", current);
        return CURRENT;
    case VOLTAGE_RCODE:
        voltage = value / 100.0;
        //printf("servo voltage  %f\n", voltage);
        return VOLTAGE;
    case CONTROLLER_TEMP_RCODE:
        controller_temp = (int16_t)value / 100.0;
        //printf("servo temp  %f\n", controller_temp);
        return CONTROLLER_TEMP;
    case MOTOR_TEMP_RCODE:
        motor_temp = (int16_t)value / 100.0;
        return MOTOR_TEMP;
    case RUDDER_SENSE_RCODE:
        if(value == 65535)
            rudder = NAN;
        else
            rudder = (uint16_t)value / 65472.0;
        return RUDDER;
    case MAX_CURRENT_RCODE:
        max_current = ((double)value) / 100;
        return MAX_CURRENT;
    case MAX_CONTROLLER_TEMP_RCODE:
        max_controller_temp = ((double)value) / 100;
        return MAX_CONTROLLER_TEMP;
    case MAX_MOTOR_TEMP_RCODE:
        max_motor_temp = ((double)value) / 100;
        return MAX_MOTOR_TEMP;
    case RUDDER_RANGE_RCODE:
        min_rudder = ((double)(value & 0xff)) / 255;
        max_rudder = ((double)((value >> 8) & 0xff)) / 255;
        return RUDDER_RANGE;
    case MAX_SLEW_RCODE:
        max_slew_speed = round(((double)(value & 0xff) * 100) / 255);
        max_slew_slow = round(((double)((value >> 8) & 0xff) * 100) / 255);
        return MAX_SLEW;
    case CURRENT_CORRECTION_RCODE:
        current_factor = 0.8 + (value & 0xff) * 0.0016;
        current_offset = (int8_t)(value >> 8);
        return CURRENT_CORRECTION;
    case VOLTAGE_CORRECTION_RCODE:
        voltage_factor = 0.8 + (value & 0xff) * 0.0016;
        voltage_offset = (int8_t)(value >> 8);
        return VOLTAGE_CORRECTION;
    case FLAGS_RCODE:
        flags = value;
        if(flags & INVALID)
            printf("servo received invalid packet (check serial connection)\n");
        return FLAGS;
    }
    return 0;
}    

int ArduinoServo::poll()
{
    if(in_buf_len < 4) {
        int c;
        for(;;) {
            int cnt = sizeof in_buf - in_buf_len;
            c = read(fd, in_buf + in_buf_len, cnt);
            if(c < cnt)
                break;
            in_buf_len = 0;
            printf("arduino server buffer overflow\n");
        }
        if(c<0) {
            if(errno != EAGAIN)
                return -1;
        }
        in_buf_len += c;
        if(in_buf_len < 4)
            return 0;
    }

    int ret = 0;
    while(in_buf_len >= 4) {
        uint8_t crc = crc8(in_buf, 3);
#if 0
        static int cnt;
        struct timeval tv;
        gettimeofday(&tv, 0);
        printf("input %d %ld:%ld %x %x %x %x %x\n", cnt++, tv.tv_sec, tv.tv_usec, in_buf[0], in_buf[1], in_buf[2], in_buf[3], crc);
#endif
        if(crc == in_buf[3]) { // valid packet
            if(in_sync_count >= 1)
                ret |= process_packet(in_buf);
            else
                in_sync_count++;
            in_buf_len-=4;
            for(int i=0; i<in_buf_len; i++)
                in_buf[i] = in_buf[i+4];
        } else {
            // invalid packet, shift by 1 byte
            in_sync_count = 0;
            in_buf_len--;
            for(int i=0; i<in_buf_len; i++)
                in_buf[i] = in_buf[i+1];
        }
    }

    return ret;
}

bool ArduinoServo::fault()
{
    return flags & OVERCURRENT;
}

void ArduinoServo::params(double _max_current, double _max_controller_temp, double _max_motor_temp, double _min_rudder, double _max_rudder, double _max_slew_speed, double _max_slew_slow, double _current_factor, double _current_offset, double _voltage_factor, double _voltage_offset)
{
    max_current = fmin(60, fmax(0, _max_current));
    max_controller_temp = fmin(80, fmax(30, _max_controller_temp));
    max_motor_temp = fmin(80, fmax(30, _max_motor_temp));
    min_rudder = fmin(1, fmax(0, _min_rudder));
    max_rudder = fmin(1, fmax(0, _max_rudder));
    max_slew_speed = fmin(100, fmax(0, _max_slew_speed));
    max_slew_slow = fmin(100, fmax(0, _max_slew_slow));
    current_factor = fmin(1.2, fmax(0.8, _current_factor));
    current_offset = fmin(127, fmax(-128, _current_offset));
    voltage_factor = fmin(1.2, fmax(0.8, _voltage_factor));
    voltage_offset = fmin(127, fmax(-128, _voltage_offset));
    params_set = 1;
}

void ArduinoServo::send_value(uint8_t command, uint16_t value)
{
    uint8_t code[4] = {command, (uint8_t)(value&0xff), (uint8_t)((value>>8)&0xff), 0};
    code[3] = crc8(code, 3);
#if 0
    struct timeval tv;
    gettimeofday(&tv, 0);
    printf("output %ld:%ld %x %x %x %x\n", tv.tv_sec, tv.tv_usec, code[0], code[1], code[2], code[3]);
#endif
    write(fd, code, 4);
}

void ArduinoServo::send_params()
{
    // send parameters occasionally, but only after parameters have been
    // initialized by the upper level
    if (params_set)
        switch(out_sync) {
        case 0: case 8: case 16:
            send_value(MAX_CURRENT_CCODE, round(max_current*100));
            break;
        case 4:
            send_value(MAX_CONTROLLER_TEMP_CCODE, round(max_controller_temp*100));
            break;
        case 6:
            send_value(MAX_MOTOR_TEMP_CCODE, round(max_motor_temp*100));
            break;
        case 12:
            send_value(RUDDER_RANGE_CCODE,
                       ((int)round(min_rudder*255) & 0xff) |
                       ((int)round(max_rudder*255) & 0xff) << 8);
            break;
        case 18:
            send_value(MAX_SLEW_CCODE,
                       ((int)(round(max_slew_speed * 255/100)) & 0xff) |
                       ((int)(round(max_slew_slow * 255/100)) & 0xff) << 8);
            break;
        case 20:
            send_value(CURRENT_CORRECTION_CCODE,
                       ((int)round((current_factor - 0.8) / 0.0016) & 0xff) |
                       ((int)current_offset & 0xff) << 8);
            break;
        case 22:
            send_value(VOLTAGE_CORRECTION_CCODE,
                       ((int)round((voltage_factor - 0.8) / 0.0016) & 0xff) |
                       ((int)voltage_offset & 0xff) << 8);
            break;
        }

    if(++out_sync == 23)
        out_sync = 0;
}

void ArduinoServo::raw_command(uint16_t value)
{
    send_params();
    //printf("command %u %d\n", value, out_sync);
    send_value(COMMAND_CCODE, value);
}

void ArduinoServo::reset()
{
    send_value(RESET_CCODE, 0);
}

void ArduinoServo::disengauge()
{
    send_params();
    send_value(DISENGAUGE_CCODE, 0);
}

void ArduinoServo::reprogram()
{
    send_value(REPROGRAM_CCODE, 0);
}
